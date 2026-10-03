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
// prerelease 按 semver 规则逐标识符比较（见 comparePrerelease）；不处理 build 元数据（+）。
export function parseVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

// 原先这里是 pa.pre.localeCompare(pb.pre)，于是 'rc.10' < 'rc.2'——字典序在第一个数字
// 字符上就比出 '1' < '2'。这不是假想：libreoffice-kit 历史上发过 0.0.2-rc4…rc9 这一串，
// 再往后一个 rc10 就会被 latestStable 判为更旧，独立线选版会停在 rc9，而纯度闸门查不出
// 来——它比的是「记录值 vs 实际装的值」，两者一致地错。
//
// semver 的规则：点分标识符逐个比；两个都是数字时按数值比，且数字标识符优先级低于任何
// 字母标识符；前面全相等时标识符少者更小。字母序按 ASCII 而非 locale，避免区域设置改结果。
function comparePrerelease(a, b) {
  const as = a.split('.');
  const bs = b.split('.');
  const shared = Math.min(as.length, bs.length);
  for (let i = 0; i < shared; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
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
  return comparePrerelease(pa.pre, pb.pre);
}

export function latestStable(versions) {
  const sorted = [...versions].sort(compareVersions);
  const stable = sorted.filter((v) => parseVersion(v)?.pre === '');
  return stable.length > 0 ? stable[stable.length - 1] : sorted[sorted.length - 1];
}

// ---- 版本区间 ----

// 只支持上游实际用到的形态：精确版，以及 `~` / `^` 后跟「主[.次[.补丁]][-预发布]」。
// 遇到其他形态（>=、||、workspace:、4.x 等）响亮失败，不猜测语义——
// 猜错会让纯度闸门静默放过一个错误的版本。
//
// 2026-10-03 上游第一次用带预发布后缀的区间：`@deepseek-ai/dsh@0.2.1-alpha.1` 声明
// `cordis: ~4.0.5-alpha.1` 与 `schemastery: ~3.18.5-alpha.1`。原实现只认整数三段，
// 探针于是报「不支持的形态」（人工排查级别），而真实情况是新 tag 正常在架。
const TILDE_CARET_RE = /^([~^])(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export function satisfiesRange(version, range) {
  const r = String(range).trim();
  if (r === '' || r === '*' || r === 'latest') return true;
  if (parseVersion(version) === null) return false;

  if (VERSION_RE.test(r)) return compareVersions(version, r) === 0;

  const m = TILDE_CARET_RE.exec(r);
  if (m === null) {
    throw new Error('不支持的版本区间形态: ' + range
      + '（已支持：精确版、~X[.Y[.Z]][-预发布]、^X[.Y[.Z]][-预发布]）');
  }
  const major = Number(m[2]);
  const hasMinor = m[3] !== undefined;
  const minor = hasMinor ? Number(m[3]) : 0;
  const hasPatch = m[4] !== undefined;
  const patch = hasPatch ? Number(m[4]) : 0;
  const pre = m[5] === undefined ? '' : '-' + m[5];
  const lower = major + '.' + minor + '.' + patch + pre;
  const lowerTuple = major + '.' + minor + '.' + patch;
  let upper;
  if (m[1] === '~') {
    // ~ 只锁到「最后一个给定的数字」：~4 → <5.0.0；~4.0 与 ~4.0.5 → <4.1.0
    upper = hasMinor ? major + '.' + (minor + 1) + '.0' : (major + 1) + '.0.0';
  } else if (major > 0) {
    upper = (major + 1) + '.0.0';
  } else if (!hasMinor) {
    upper = '1.0.0';                                  // ^0 → <1.0.0
  } else if (!hasPatch) {
    upper = '0.' + (minor + 1) + '.0';                // ^0.0 → <0.1.0，不因为没给补丁就锁成 0.0.z
  } else if (minor > 0) {
    upper = '0.' + (minor + 1) + '.0';
  } else {
    upper = '0.0.' + (patch + 1);
  }
  if (compareVersions(version, lower) < 0 || compareVersions(version, upper) >= 0) return false;
  // node-semver 的预发布规则：默认不接受预发布候选，除非区间自身在同一个
  // [主,次,补丁] 三元组上带预发布下界。4.0.5-alpha.1 满足 ~4.0.5-alpha.1，
  // 但 4.0.6-alpha.1 不满足——区间没有把候选面放开到那个三元组。
  const parsed = parseVersion(version);
  if (parsed.pre === '') return true;
  return pre !== '' && parsed.nums.join('.') === lowerTuple;
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

/**
 * 上游给「某次 dsh 发布专用的」独立版本线包打的 dist-tag 名。
 * 实测 2026-10-03：`dsh-v0.2.1-alpha.1` 这次发布，cordis / schemastery / cosmokit 以及四个
 * cordis-plugin-* 都带 `dsh-0-2-1-alpha-1` 指向本次要用的版本，而它们的 `latest` 全部还停在
 * 上一次的稳定版。命名规则是 `dsh-` + 版本号里所有点换成连字符。
 */
export function releaseDistTag(tagVersion) {
  return 'dsh-' + String(tagVersion).replace(/\./g, '-');
}

// 无声明可依（只经 optional peer 可达）时退回最新稳定版；
// 有声明却无版本可满足时返回 undefined，由调用方响亮失败。
//
// releaseTagged 是上游 `dsh-<版本>` 专属 dist-tag 指向的版本，存在即优先采纳：
// 那是发布方对「这一版该用哪个」的直接回答。为什么不能只靠区间——见 resolveIndependentVersions
// 的注释，闭包收集边时读的是 latestStable 的 manifest，独立线进入预发布形态后那个猜测会失准。
export function chooseIndependentVersion(publishedVersions, ranges, releaseTagged) {
  if (releaseTagged !== undefined && releaseTagged !== null) {
    if (!publishedVersions.includes(releaseTagged)) {
      throw new Error('上游发布 tag 指向 ' + releaseTagged + '，但 registry 的已发布列表里没有它：'
        + publishedVersions.slice(-4).join(', ') + '（可能是 registry 缓存滞后，等一轮再判）');
    }
    return releaseTagged;
  }
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
//
// releaseTagged 是上游 `dsh-<版本>` 专属 dist-tag 指向的版本。它存在时**读它的 manifest**，
// 而不是 latestStable 的：独立线包进入预发布形态后，稳定版那份声明描述的是上一次发布
// （cordis-plugin-timer@1.1.6 说 cordis `~4.0.4`，而 1.1.7-alpha.1 说 `~4.0.5-alpha.1`）。
// 用哪一版装配，就该收哪一版的边——否则闭包会把两个不会同时存在的版本的声明混成一组约束，
// 选版与闸门各自红一次。
export function classifyPackage(packument, tagVersion, releaseTagged) {
  const versions = packument?.versions ?? {};
  const published = Object.keys(versions);
  if (versions[tagVersion]) {
    return { kind: 'pinnable', version: tagVersion, manifest: versions[tagVersion], published };
  }
  const chosen = versions[releaseTagged] !== undefined ? releaseTagged : latestStable(published);
  return {
    kind: 'independent',
    version: chosen,
    manifest: versions[chosen],
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

// BFS 结束后统一选版：优先采纳上游的 `dsh-<版本>` 发布专属 dist-tag（ADR 0002），
// 没有该 tag 才退回「跟随依赖方声明区间」（ADR 0001）；peer 补齐包由本仓库写进 dependencies。
//
// 为什么区间求解不足以独立支撑选版：闭包收集边时，独立线包读的是 `latestStable` 那份
// manifest 的声明（见 classifyPackage），而最终解出的可能是另一个版本——那个版本自己的
// 声明从来没被读进来。稳定版与预发布版并存的上游会因此把两个版本的声明混成一组约束。
export function resolveIndependentVersions(publishedByPackage, edges, options = {}) {
  const { tagVersion, distTagsByPackage } = options;
  const out = new Map();
  const wanted = tagVersion === undefined ? undefined : releaseDistTag(tagVersion);
  for (const [name, published] of publishedByPackage) {
    const ranges = declaredRanges(name, edges);
    const tagged = wanted === undefined ? undefined : distTagsByPackage?.get(name)?.[wanted];
    const version = chooseIndependentVersion(published, ranges, tagged);
    if (version === undefined) {
      throw new Error('独立版本线包 ' + name + ' 没有任何已发布版本能同时满足声明区间 '
        + JSON.stringify(ranges) + '；已发布: ' + published.join(', '));
    }
    out.set(name, {
      version,
      ranges,
      declared: isPeerOnly(name, edges),
      chosenBy: tagged !== undefined ? 'upstream-release-tag'
        : ranges.length === 0 ? 'no-declaration' : 'declared-ranges',
    });
  }
  return out;
}

/**
 * 找出「闭包要求它等于 tag 版本，但 registry 上还没这个版本」的家族包。
 *
 * 上游的 npm 家族是分批发布的（实测根包与成员包相差 20 分钟以上），所以这种缺口通常是
 * 发布窗口还没关，等一轮就好；它和「声明区间形态不认识 / 永远无解」是两类问题——后者等不来，
 * 必须保持红。调用方据此决定空转退出还是构建失败。
 *
 * 只认精确等于 tagVersion 的声明：`~4.0.4` 那类独立版本线包本来就不跟 tag 走，
 * 缺 tagVersion 对它们而言是正常的，不是竞态信号。
 */
export function findUnpublishedFamilyMembers(publishedByPackage, edges, tagVersion) {
  const waiting = [];
  for (const [name, published] of publishedByPackage) {
    if (!isFamilyPackage(name)) continue;
    if (published.includes(tagVersion)) continue;
    if (!declaredRanges(name, edges).includes(tagVersion)) continue;
    waiting.push({ name, latest: published.length > 0 ? published[published.length - 1] : '(无)' });
  }
  return waiting;
}

/**
 * 回放基线的落后判定（#30 的触发点）。
 *
 * 基线文件名里的 tag 就是它录制时的上游状态；探针每天已经在算实时 tag，
 * 两者一比即知回放是否在测一个过期的图。这里只做字符串与比较，读目录归调用方。
 *
 * @param filenames - fixtures 目录下的文件名集合
 * @param tagVersion - 本次探针的实时 tag 版本
 * @returns {{ newest: string|null, lagging: boolean, count: number }}
 */
export function newestReplayBaseline(filenames, tagVersion) {
  const tags = filenames
    .map((f) => /^pin-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.json$/.exec(f)?.[1])
    .filter((t) => t !== undefined);
  if (tags.length === 0) return { newest: null, lagging: true, count: 0 };
  const newest = tags.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  // 只有基线**比实时 tag 旧**才叫落后。显式拿历史 tag 跑探针时基线反而更新，
  // 报「落后」是说反；相等当然也不落后。
  const lagging = newest !== tagVersion && compareVersions(newest, tagVersion) < 0;
  return { newest, lagging, count: tags.length };
}

// ---- 家族闭包遍历 ----

// 定点迭代的上限。真实收敛用了 2–3 轮（seed→插件换版→cordis 换版→稳定），留余量。
const MAX_CLOSED_ROUNDS = 6;

/**
 * 从主包出发做家族闭包遍历（dependencies + peerDependencies 双通道，池化拉取），
 * 并把「读哪个版本的声明」迭代到定点。
 *
 * 为什么必须定点：独立版本线包的版本要等全部边收集完才解得出，而边本身取决于每个包
 * 当前被读的是哪份 manifest。用 `latestStable` 一次性猜（ADR 0001 的最初实现）在独立线
 * 进入预发布形态后会猜错：插件的 1.1.6 那份 manifest 描述的是上一次发布的约束，于是闭包里
 * 同时出现 `~4.0.5-alpha.1` 与 `~4.0.4`，模型判「永远无解」，而 npm 递归解析装得很好。
 * 每轮用上一轮解出的版本重收边，边就总是来自真正装配那份代码的声明——和 npm 同一个不动点。
 *
 * 上游的 `dsh-<版本>` 发布专属 dist-tag（ADR 0002）作为 seed 与优先来源参与：它不参与推算的
 * 部分是「发布方指定」这个事实，定点迭代负责让其余包与之一致。
 *
 * fetchPackument 由调用方注入，因此同一套遍历既能跑实时 registry、也能跑录制 fixture；
 * onVisit 供录制器拿到原始元数据做投影。
 */
export async function walkFamilyClosure(rootPackage, tagVersion, fetchPackument, options = {}) {
  const { pool = 12, onVisit, maxRounds = MAX_CLOSED_ROUNDS } = options;
  const wanted = releaseDistTag(tagVersion);
  const metas = new Map();
  const pinnable = new Set();
  const publishedByPackage = new Map();
  const distTagsByPackage = new Map();
  /** name -> 本轮读取 manifest 所用的版本（同版本线包恒为 tagVersion）。 */
  const chosen = new Map();
  /** name -> 迭代过程中真的被读过 manifest 的版本集合，供录制器如实投影 fixture。 */
  const readVersions = new Map();

  function register(name, meta) {
    if (meta === null) throw new Error('packument 三次重试仍失败: ' + name);
    metas.set(name, meta);
    onVisit?.(name, meta);
    // 没有 dist-tags 的包存空对象，查表时不必区分「没取到」。
    const distTags = meta['dist-tags'] ?? {};
    distTagsByPackage.set(name, distTags);
    const versions = meta.versions ?? {};
    const published = Object.keys(versions);
    // 家族包在 registry 上一个可用版本都没有（被撤包或废弃）。此时必须响亮失败：
    // 静默跳过会让安装包缺一个运行时核心包，而纯度闸门的意义正是不放过这种情况。
    if (published.length === 0) {
      throw new Error('家族包 ' + name + ' 在 registry 上没有任何可用版本，无法钉死版本线');
    }
    const tagged = distTags[wanted];
    const classified = classifyPackage(meta, tagVersion,
      published.includes(tagged) ? tagged : undefined);
    if (classified.kind === 'pinnable') {
      pinnable.add(name);
      chosen.set(name, tagVersion);
    } else {
      // 主包在 npm 上无此 tag 版本 = 上游该 release 未发布 npm 包（如 alpha 线只发 GitHub）。
      // 这里不抛错，交给调用方按「主包不在 pinnable 里」判——它是一类清晰的跳过，不是故障。
      pinnable.delete(name);
      publishedByPackage.set(name, classified.published);
      chosen.set(name, classified.version);
    }
  }

  async function fetchBatch(names) {
    for (let i = 0; i < names.length; i += pool) {
      const chunk = names.slice(i, i + pool);
      const got = await Promise.all(chunk.map(async (name) => {
        try { return await fetchPackument(name); } catch { return null; }
      }));
      for (let j = 0; j < chunk.length; j += 1) register(chunk[j], got[j]);
    }
  }

  // 用当前 chosen 指向的 manifest 重收全部边；顺带记下还没拉过的名字。
  function collectEdges() {
    const next = new Map();
    const unseen = [];
    for (const [name, meta] of metas) {
      const version = chosen.get(name);
      if (!readVersions.has(name)) readVersions.set(name, new Set());
      readVersions.get(name).add(version);
      for (const edge of familyEdges(meta.versions?.[version])) {
        let list = next.get(edge.name);
        if (list === undefined) next.set(edge.name, list = []);
        list.push(edge);
        if (!metas.has(edge.name) && !unseen.includes(edge.name)) unseen.push(edge.name);
      }
    }
    return { edges: next, unseen };
  }

  // 一轮求解。中间轮允许某个包暂时解不出（它的边还没被上游新版本的声明刷新），
  // 那种情况保持原 seed 不动；最后一轮由 resolveIndependentVersions 负责响亮失败。
  function pickRound(edges) {
    const picks = new Map();
    for (const [name, published] of publishedByPackage) {
      const ranges = declaredRanges(name, edges);
      const tagged = distTagsByPackage.get(name)?.[wanted];
      let version;
      try {
        version = chooseIndependentVersion(published, ranges, published.includes(tagged) ? tagged : undefined);
      } catch {
        continue;
      }
      if (version !== undefined) picks.set(name, version);
    }
    return picks;
  }

  await fetchBatch([rootPackage]);
  let edges = new Map();
  let rounds = 0;
  const history = new Set();
  let converged = false;
  while (rounds < maxRounds) {
    rounds += 1;
    const collected = collectEdges();
    edges = collected.edges;
    if (collected.unseen.length > 0) await fetchBatch(collected.unseen);
    let moved = false;
    for (const [name, version] of pickRound(edges)) {
      if (chosen.get(name) !== version) { chosen.set(name, version); moved = true; }
    }
    if (!moved && collected.unseen.length === 0) { converged = true; break; }
    const signature = [...chosen.entries()].sort().map(([n, v]) => n + '@' + v).join('|');
    if (history.has(signature)) {
      throw new Error('独立版本线选版震荡：第 ' + rounds + ' 轮回到了已出现过的状态，无法收敛。'
        + '涉及: ' + [...publishedByPackage.keys()].join(', '));
    }
    history.add(signature);
  }
  if (!converged) {
    throw new Error('独立版本线选版在 ' + maxRounds + ' 轮内未收敛，把 maxRounds 提上去之前先确认上游声明没有互斥');
  }

  // 收敛态的权威选版由调用方解（resolveIndependentVersions）：闭包只负责把「读哪份 manifest」
  // 推到定点。把严格求解搬进来会抢在探针「上游还没发齐」的分类之前抛错，
  // 于是发布窗口里的一次正常等待被报成退出码 1。
  return {
    pinnable, publishedByPackage, distTagsByPackage, edges, chosenVersions: chosen, rounds,
    manifestVersionsRead: new Map([...readVersions].map(([n, set]) => [n, [...set]])),
  };
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
