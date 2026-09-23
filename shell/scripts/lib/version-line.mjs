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

// 简易语义化版本比较：release 数字段优先，stable 高于同号 prerelease。
// 独立线选版够用，不实现完整 semver。
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
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

// ---- 分类 ----

// 判定单个家族包属于同版本线还是独立版本线。
// packument 为 registry 元数据；缺失或无 versions 时按独立线处理（与原实现一致）。
export function classifyPackage(packument, tagVersion) {
  const versions = packument?.versions ?? {};
  if (versions[tagVersion]) {
    return { kind: 'pinnable', version: tagVersion, manifest: versions[tagVersion] };
  }
  const chosen = latestStable(Object.keys(versions));
  return {
    kind: 'independent',
    version: chosen,
    manifest: chosen === undefined ? undefined : versions[chosen],
  };
}

// 取出一个包 manifest 里指向家族包的依赖边与 peer 边。
// peer 边带 optional 标记：optional peer 不构成「必须显式补齐」。
export function familyEdges(manifest) {
  const out = [];
  if (!manifest) return out;
  const pm = manifest.peerDependenciesMeta ?? {};
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (isFamilyPackage(dep)) out.push({ name: dep, kind: 'dep', optional: false });
  }
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (isFamilyPackage(peer)) out.push({ name: peer, kind: 'peer', optional: pm[peer]?.optional === true });
  }
  return out;
}

// ---- peer 补齐 ----

// 仅以非 optional peer 出现、没有 dep 边的家族包必须显式写进 dependencies：
// legacy peer 解析模式下 npm 不会自动安装 peer，漏装会导致运行时缺核心包。
export function computeRequiredPeers(pinnable, independent, edges, tagVersion) {
  const required = {};
  const candidates = [...pinnable].map((n) => [n, tagVersion]).concat([...independent.entries()]);
  for (const [name, version] of candidates) {
    const es = edges.get(name) ?? [];
    const hasDepEdge = es.some((e) => e.kind === 'dep');
    const hasRequiredPeer = es.some((e) => e.kind === 'peer' && !e.optional);
    if (!hasDepEdge && hasRequiredPeer) required[name] = version;
  }
  return required;
}

// ---- manifest 组装 ----

// 家族依赖整体重建，防残留旧 pin 冲突。非家族依赖原样保留。
export function buildDependencies(existingDependencies, tagVersion, independent, requiredPeers, rootPackage) {
  const nonFamily = Object.fromEntries(
    Object.entries(existingDependencies ?? {}).filter(([n]) => !isFamilyPackage(n)),
  );
  return {
    ...nonFamily,
    [rootPackage]: tagVersion,
    ...Object.fromEntries(independent),
    ...requiredPeers,
  };
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

// 收集某个包在树里出现过的全部版本，顶层优先，其余按字典序，保证输出确定性。
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

// 独立版本线按顶层副本判定：嵌套的旧副本是依赖方自己声明的结果，不是纯度缺陷。
export function checkIndependentVersions(independent, installed) {
  return [...independent.entries()]
    .filter(([n, v]) => installed.topLevel.get(n) !== v)
    .map(([n, v]) => {
      const actual = installed.topLevel.get(n);
      return n + '@' + v + (actual === undefined ? '（缺失）' : '（实际 ' + actual + '）');
    });
}

// ---- 构建版本清单 ----

// 清单会原样进入面向用户的发布说明（release-desktop.yml 用 jq 读 .pinnedCount
// 与 .independent），故其形状是对外契约，改动需同步改发布说明生成。
// .independent 取记录值而非重新观测：三处闸门已在此前证明记录值等于顶层实际安装值，
// 闸门不过则脚本早已退出，不会走到这里。
export function buildReport(tagVersion, pinnable, independent, installed) {
  const pinnedNames = [...pinnable].filter((n) => installed.topLevel.get(n) === tagVersion);
  return {
    tag: tagVersion,
    pinnedCount: pinnedNames.length,
    pinned: Object.fromEntries(pinnedNames.map((n) => [n, tagVersion])),
    independent: Object.fromEntries(independent),
  };
}
