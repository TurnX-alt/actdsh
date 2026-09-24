// 版本线钉死的决策逻辑：全部为纯函数，不做任何 IO。
// 术语定义见仓库根 CONTEXT.md；独立版本线的选版依据见
// docs/adr/0001-independent-version-line-follows-declared-ranges.md。
//
// 本模块由 pin-upstream.mjs 编排调用，拆分目的是让判定逻辑可以在秒级、离线、
// 确定性的条件下被测试——此前它只存在于发布路径上，零测试覆盖。
const FAMILY_SCOPE = '@deepseek-ai/';

export function isFamilyPackage(name) {
  return typeof name === 'string' && name.startsWith(FAMILY_SCOPE);
}

// ---- 版本比较 ----

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// 简易语义化版本比较：release 数字段优先，stable 高于同号 prerelease。
// 独立线选版够用，不实现完整 semver。
export function parseVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre.localeCompare(pb.pre);
}

export function latestStable(versions) {
  const sorted = [...versions].sort(compareVersions);
  const stable = sorted.filter((v) => parseVersion(v)?.pre === '');
  return stable.length > 0 ? stable[stable.length - 1] : sorted[sorted.length - 1];
}

// ---- 版本区间 ----

// 只支持上游实际用到的三种形态：精确版、~X.Y.Z、^X.Y.Z。
// 遇到其他形态（>=、||、workspace: 等）响亮失败，不猜测语义——
// 猜错会让纯度闸门静默放过一个错误的版本。
export function satisfiesRange(version, range) {
  const r = String(range).trim();
  if (r === '' || r === '*' || r === 'latest') return true;
  if (parseVersion(version) === null) return false;

  if (VERSION_RE.test(r)) return compareVersions(version, r) === 0;

  const m = /^([~^])(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (m === null) {
    throw new Error('不支持的版本区间形态: ' + range + '（已支持：精确版、~X.Y.Z、^X.Y.Z）');
  }
  const major = Number(m[2]);
  const minor = Number(m[3]);
  const patch = Number(m[4]);
  const lower = major + '.' + minor + '.' + patch;
  let upper;
  if (m[1] === '~') upper = major + '.' + (minor + 1) + '.0';
  else if (major > 0) upper = (major + 1) + '.0.0';
  else if (minor > 0) upper = '0.' + (minor + 1) + '.0';
  else upper = '0.0.' + (patch + 1);
  return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
}

// 取会真正进入安装树的声明：dep 边，以及非 optional 的 peer 边。
// optional peer 不会被强制安装，因此不构成约束。
// 去重是必要的：cordis 这类被 270 条边指向的包，未去重的区间列表会让
// 「无版本可满足」的失败消息变成不可读的一大坨。
export function declaredRanges(name, edges) {
  const out = [];
  for (const e of edges.get(name) ?? []) {
    if (e.kind !== 'dep' && !(e.kind === 'peer' && !e.optional)) continue;
    if (typeof e.range === 'string' && !out.includes(e.range)) out.push(e.range);
  }
  return out;
}

export function highestSatisfying(publishedVersions, ranges) {
  const ok = publishedVersions.filter((v) => ranges.every((r) => satisfiesRange(v, r)));
  return ok.length === 0 ? undefined : latestStable(ok);
}

// 无声明可依（只经 optional peer 可达）时退回最新稳定版；
// 有声明却无版本可满足时返回 undefined，由调用方响亮失败。
export function chooseIndependentVersion(publishedVersions, ranges) {
  if (ranges.length === 0) return latestStable(publishedVersions);
  return highestSatisfying(publishedVersions, ranges);
}

// 仅以非 optional peer 出现、没有 dep 边的家族包必须显式声明：
// legacy peer 解析模式下 npm 不会自动安装 peer，漏装会导致运行时缺核心包。
export function isPeerOnly(name, edges) {
  const es = edges.get(name) ?? [];
  return !es.some((e) => e.kind === 'dep') && es.some((e) => e.kind === 'peer' && !e.optional);
}

// ---- 分类 ----

// 判定单个家族包属于同版本线还是独立版本线，并带回已发布版本列表，
// 供 BFS 结束后按声明区间选版（选版依赖完整的边信息，不能在 BFS 途中定）。
export function classifyPackage(packument, tagVersion) {
  const versions = packument?.versions ?? {};
  const published = Object.keys(versions);
  if (versions[tagVersion]) {
    return { kind: 'pinnable', version: tagVersion, manifest: versions[tagVersion], published };
  }
  return {
    kind: 'independent',
    version: latestStable(published),
    manifest: versions[latestStable(published)],
    published,
  };
}

// 取出一个包 manifest 里指向家族包的依赖边与 peer 边，含声明区间。
export function familyEdges(manifest) {
  const out = [];
  if (!manifest) return out;
  const pm = manifest.peerDependenciesMeta ?? {};
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (isFamilyPackage(dep)) out.push({ name: dep, kind: 'dep', optional: false, range });
  }
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (isFamilyPackage(peer)) {
      out.push({ name: peer, kind: 'peer', optional: pm[peer]?.optional === true, range });
    }
  }
  return out;
}

// BFS 结束后统一选版：独立版本线跟随依赖方声明（ADR 0001），
// 只有 peer 补齐包需要由本仓库写进 dependencies。
export function resolveIndependentVersions(publishedByPackage, edges) {
  const out = new Map();
  for (const [name, published] of publishedByPackage) {
    const ranges = declaredRanges(name, edges);
    const version = chooseIndependentVersion(published, ranges);
    if (version === undefined) {
      throw new Error('独立版本线包 ' + name + ' 没有任何已发布版本能同时满足声明区间 '
        + JSON.stringify(ranges) + '；已发布: ' + published.join(', '));
    }
    out.set(name, { version, ranges, declared: isPeerOnly(name, edges) });
  }
  return out;
}

// ---- 家族闭包遍历 ----

// 从主包出发做家族闭包 BFS（dependencies + peerDependencies 双通道，池化拉取）。
// fetchPackument 由调用方注入，因此同一套遍历既能跑实时 registry、也能跑录制 fixture；
// onVisit 供录制器拿到原始元数据做投影。
// 选版不在这里做：独立版本线的版本由依赖方声明的区间决定，而区间要等全部边收集完才完整。
export async function walkFamilyClosure(rootPackage, tagVersion, fetchPackument, options = {}) {
  const { pool = 12, onVisit } = options;
  const pinnable = new Set([rootPackage]);
  const publishedByPackage = new Map();
  const edges = new Map();
  const queue = [rootPackage];
  while (queue.length > 0) {
    const chunk = queue.splice(0, pool);
    const metas = await Promise.all(chunk.map(async (name) => {
      try { return await fetchPackument(name); } catch { return null; }
    }));
    for (let i = 0; i < chunk.length; i += 1) {
      const name = chunk[i];
      const meta = metas[i];
      if (meta === null) throw new Error('packument 三次重试仍失败: ' + name);
      onVisit?.(name, meta);
      const classified = classifyPackage(meta, tagVersion);
      if (classified.kind === 'pinnable') {
        pinnable.add(name);
      } else {
        pinnable.delete(name);
        // 家族包在 registry 上一个可用版本都没有（被撤包或废弃）。此时必须响亮失败：
        // 静默跳过会让安装包缺一个运行时核心包，而纯度闸门的意义正是不放过这种情况。
        if (classified.published.length === 0) {
          throw new Error('家族包 ' + name + ' 在 registry 上没有任何可用版本，无法钉死版本线');
        }
        publishedByPackage.set(name, classified.published);
      }
      for (const edge of familyEdges(classified.manifest)) {
        let list = edges.get(edge.name);
        if (list === undefined) edges.set(edge.name, list = []);
        list.push(edge);
        if (!pinnable.has(edge.name) && !publishedByPackage.has(edge.name) && !queue.includes(edge.name)) {
          queue.push(edge.name);
        }
      }
    }
  }
  return { pinnable, publishedByPackage, edges };
}

// ---- peer 补齐 ----

export function computeRequiredPeers(pinnable, independent, edges, tagVersion) {
  const required = {};
  for (const name of pinnable) {
    if (isPeerOnly(name, edges)) required[name] = tagVersion;
  }
  for (const [name, info] of independent) {
    if (info.declared) required[name] = info.version;
  }
  return required;
}

// ---- manifest 组装 ----

// 家族依赖整体重建，防残留旧 pin 冲突。非家族依赖原样保留。
// 有 dep 边的独立版本线包不在此声明：交给 npm 按依赖方的区间解析，
// 这样树里只有一份副本，且其版本必然是上游声明过的那个。
export function buildDependencies(existingDependencies, tagVersion, requiredPeers, rootPackage) {
  const nonFamily = Object.fromEntries(
    Object.entries(existingDependencies ?? {}).filter(([n]) => !isFamilyPackage(n)),
  );
  return { ...nonFamily, [rootPackage]: tagVersion, ...requiredPeers };
}

// 同版本线包写 overrides 强制全树收敛；独立线不写，允许子树按声明解析。
export function buildOverrides(pinnable, tagVersion) {
  const overrides = {};
  for (const name of pinnable) overrides[name] = tagVersion;
  return overrides;
}

// ---- 安装树记账 ----

// entries: [{ name, version, relativePath }]，relativePath 相对安装根，形如
//   node_modules/@deepseek-ai/x/package.json
//   node_modules/@deepseek-ai/y/node_modules/@deepseek-ai/x/package.json
// 顶层副本与嵌套副本的区分依据是路径里 node_modules 段数。
export function nestingDepth(relativePath) {
  return String(relativePath).split('node_modules').length - 1;
}

// 把安装树记录分成顶层副本与嵌套副本两份。
// 二者必须分开：嵌套副本是包管理器的正常行为（依赖方要求的版本与顶层不同时必然出现），
// 把两层压进同一个按名索引的映射会让嵌套值覆盖顶层值，从而把正确的树判成错误——
// 2026-09-23 的发布失败正是这么来的。
export function indexInstalledTree(entries) {
  const topLevel = new Map();
  const nested = new Map();
  for (const entry of entries) {
    if (nestingDepth(entry.relativePath) > 1) {
      let versions = nested.get(entry.name);
      if (versions === undefined) nested.set(entry.name, versions = new Set());
      versions.add(entry.version);
    } else {
      topLevel.set(entry.name, entry.version);
    }
  }
  return { topLevel, nested };
}

// 收集某个包在树里出现过的全部版本，顶层优先，其余按版本序，保证输出确定性。
function allVersionsOf(name, installed) {
  const versions = [];
  const top = installed.topLevel.get(name);
  if (top !== undefined) versions.push(top);
  for (const v of [...(installed.nested.get(name) ?? [])].sort(compareVersions)) {
    if (!versions.includes(v)) versions.push(v);
  }
  return versions;
}

// ---- 三处闸门 ----

// 同版本线：全树每一个副本都必须等于 tag 版本，顶层与嵌套都要查。
// 未安装的包不在此报告（与原实现一致），漏装由 npm 自身或后续校验暴露。
export function checkPinnedPurity(pinnable, tagVersion, installed) {
  const drift = [];
  for (const name of pinnable) {
    for (const version of allVersionsOf(name, installed)) {
      if (version !== tagVersion) drift.push(name + '@' + version);
    }
  }
  return drift;
}

// peer 补齐包按顶层副本判定：它由本仓库显式声明，解析落点必然在顶层。
export function checkRequiredPeers(requiredPeers, installed) {
  return Object.keys(requiredPeers)
    .filter((n) => installed.topLevel.get(n) !== requiredPeers[n])
    .map((n) => {
      const actual = installed.topLevel.get(n);
      return n + '@' + requiredPeers[n] + (actual === undefined ? '（缺失）' : '（实际 ' + actual + '）');
    });
}

// 独立版本线：顶层必须存在一份副本，其版本必须满足依赖方声明的全部区间；
// 若由本仓库显式声明（peer 补齐），还必须等于选定版本。
// 断言对象是顶层副本——嵌套的旧副本是依赖方自己声明的结果，不是纯度缺陷。
export function checkIndependentVersions(independent, installed) {
  const problems = [];
  for (const [name, info] of independent) {
    const observed = installed.topLevel.get(name);
    if (observed === undefined) {
      problems.push(name + '@' + info.version + '（缺失）');
      continue;
    }
    if (info.declared && observed !== info.version) {
      problems.push(name + '@' + info.version + '（实际 ' + observed + '）');
      continue;
    }
    const violated = info.ranges.filter((r) => !satisfiesRange(observed, r));
    if (violated.length > 0) {
      problems.push(name + '@' + observed + '（不满足声明区间 ' + violated.join('、') + '）');
    }
  }
  return problems;
}

// ---- 构建版本清单 ----

// 清单会原样进入面向用户的发布说明（release-desktop.yml 用 jq 读 .pinnedCount
// 与 .independent），故其形状是对外契约，改动需同步改发布说明生成。
// .independent 取安装树顶层的观测值而非选版意图：闸门已保证它满足全部声明区间，
// 而 CONTEXT.md 要求清单必须是观测结果。
export function buildReport(tagVersion, pinnable, independent, installed) {
  const pinnedNames = [...pinnable].filter((n) => installed.topLevel.get(n) === tagVersion);
  return {
    tag: tagVersion,
    pinnedCount: pinnedNames.length,
    pinned: Object.fromEntries(pinnedNames.map((n) => [n, tagVersion])),
    independent: Object.fromEntries([...independent.keys()].map((n) => [n, installed.topLevel.get(n)])),
  };
}
