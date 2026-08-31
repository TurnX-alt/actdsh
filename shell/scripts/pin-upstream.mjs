// 版本线钉死（单阶段 + legacy 解析）：
// 1) 经 registry 元数据 BFS 出与上游 tag 同版本线的家族包闭包（dependencies + peerDependencies 双通道扩展），
//    无此 tag 版本的独立版本线包（cordis、schemastery 等）各自记录最新稳定版；
// 2) 主包 + 全部独立线包以精确版写入 dependencies，同版本线包以精确版写入 overrides；
// 3) npm install --legacy-peer-deps 一次性安装（带硬超时）。
// 为什么 --legacy-peer-deps：npm 严格模式对新版本线的全量解析要在 ~200 包、300+ 条 peer 边的图上
// 做 peer 推断，实测连续 60+ 分钟每秒一条「ERESOLVE overriding peer dependency」不收敛（alpha.2 实证，
// 直到 job 超时被杀）。legacy 模式跳过 peer 推断（实测 51 秒装完 492 包、0 条 ERESOLVE）；
// 代价是 npm 不再自动安装「仅以 peer 出现」的包——此前 --legacy-peer-deps 因 cordis-plugin-group
// 缺失被回退的根因——故本脚本把 peer 闭包内的独立版本线包全部显式写进 dependencies，
// 最终树与严格模式自动安装结果等价，且全程无 peer 推断。
// 用法（cwd = shell/runtime）: node ../scripts/pin-upstream.mjs <tag-version>
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const V = process.argv[2];
if (!V) {
  console.error('usage: node ../scripts/pin-upstream.mjs <tag-version>');
  process.exit(2);
}
const NPM = 'npm';
const NPM_OPTS = process.platform === 'win32' ? { shell: true } : {};
const POOL = 12;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

// 元数据拉取带重试：瞬断误判为独立版本线会让钉死集随网络抖动漂移（实测三跑三不同）。
async function packument(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2f');
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('packument ' + res.status + ' for ' + name);
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('packument failed for ' + name);
}

// 简易语义化版本比较：release 数字段优先，stable 高于同号 prerelease（独立线取最新稳定版用，不必完整实现 semver）。
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}
function compareVersions(a, b) {
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
function latestStable(versions) {
  const sorted = [...versions].sort(compareVersions);
  const stable = sorted.filter((v) => parseVersion(v)?.pre === '');
  return stable.length > 0 ? stable[stable.length - 1] : sorted[sorted.length - 1];
}

// 1. 从主包出发 BFS（dependencies + peerDependencies 双通道，池化拉取）：
//    有该 tag 版本的包入钉死集；无该 tag 版本的独立版本线包记录最新稳定版并同样扩展其依赖/peer。
const pinnable = new Set(['@deepseek-ai/dsh']);
const independent = new Map();
const queue = ['@deepseek-ai/dsh'];
// 边记录：name -> [{kind: 'dep'|'peer', optional}]，用于识别「仅以 peer 出现」的包（legacy 模式不自动装 peer）
const edges = new Map();
const enqueue = (from, name, kind, optional) => {
  let list = edges.get(name);
  if (!list) edges.set(name, list = []);
  list.push({ from, kind, optional });
  if (!pinnable.has(name) && !independent.has(name) && !queue.includes(name)) queue.push(name);
};
while (queue.length > 0) {
  const chunk = queue.splice(0, POOL);
  const metas = await Promise.all(chunk.map(async (name) => {
    try { return await packument(name); } catch { return null; }
  }));
  for (let i = 0; i < chunk.length; i += 1) {
    const name = chunk[i];
    const meta = metas[i];
    if (meta === null) throw new Error('packument 三次重试仍失败: ' + name);
    const versions = meta.versions ?? {};
    if (versions[V]) {
      pinnable.add(name);
      const v = versions[V];
      const pm = v.peerDependenciesMeta ?? {};
      for (const dep of Object.keys(v.dependencies ?? {})) if (dep.startsWith('@deepseek-ai/')) enqueue(name, dep, 'dep', false);
      for (const peer of Object.keys(v.peerDependencies ?? {})) if (peer.startsWith('@deepseek-ai/')) enqueue(name, peer, 'peer', pm[peer]?.optional === true);
    } else {
      // 关键：有 tag 版本才可钉；无该 tag 版本即独立版本线（cordis ETARGET 实证），取最新稳定版显式安装
      pinnable.delete(name);
      independent.set(name, latestStable(Object.keys(versions)));
      const v = versions[independent.get(name)];
      if (v) {
        const pm = v.peerDependenciesMeta ?? {};
        for (const dep of Object.keys(v.dependencies ?? {})) if (dep.startsWith('@deepseek-ai/')) enqueue(name, dep, 'dep', false);
        for (const peer of Object.keys(v.peerDependencies ?? {})) if (peer.startsWith('@deepseek-ai/')) enqueue(name, peer, 'peer', pm[peer]?.optional === true);
      }
    }
  }
}
console.log('同版本线包 ' + pinnable.size + ' 个；独立版本线 ' + independent.size + ' 个: ' + [...independent.entries()].map(([n, v]) => n + '@' + v).sort().join(', '));

// 主包在 npm 上无此 tag 版本 = 上游该 release 未发布 npm 包（如 alpha 线只发 GitHub）：
// 提前以清晰文案失败，避免把不存在的版本写进 dependencies 后死在晦涩的 npm ETARGET。
if (!pinnable.has('@deepseek-ai/dsh')) {
  console.error('npm 注册表不存在 @deepseek-ai/dsh@' + V + '：上游该 release 未发布 npm 包，无法钉死版本线。');
  process.exit(1);
}

// 2. 主包与独立线写入 dependencies、同版本线写入 overrides（家族依赖整体重建，防残留旧 pin 冲突）。
//    独立线只作精确依赖、不写 overrides：若未来有包需要其旧主版本，npm 可在子树嵌套解析。
//    仅以 peer 出现的家族包（无 dep 边、有非 optional peer 边）也必须显式写入 dependencies：
//    严格模式下 npm 会自动安装这些 peer，legacy 模式不会，漏装会导致运行时缺核心包。
const manifestPath = 'package.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const nonFamily = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([n]) => !n.startsWith('@deepseek-ai/')));
const requiredPeers = {};
for (const [name, version] of [...pinnable].map((n) => [n, V]).concat([...independent.entries()])) {
  const es = edges.get(name) ?? [];
  const hasDepEdge = es.some((e) => e.kind === 'dep');
  const hasRequiredPeer = es.some((e) => e.kind === 'peer' && !e.optional);
  if (!hasDepEdge && hasRequiredPeer) requiredPeers[name] = version;
}
manifest.dependencies = { ...nonFamily, '@deepseek-ai/dsh': V, ...Object.fromEntries(independent), ...requiredPeers };
manifest.overrides = {};
for (const name of pinnable) manifest.overrides[name] = V;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 3. 单次安装（legacy 解析 + 硬超时；超时给出明确归因而非无界卡死）
const installStart = Date.now();
try {
  execFileSync(NPM, ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
    stdio: 'inherit',
    timeout: INSTALL_TIMEOUT_MS,
    ...NPM_OPTS,
  });
} catch (error) {
  if (error?.code === 'ETIMEDOUT' || error?.killed) {
    console.error('npm install 超过 ' + INSTALL_TIMEOUT_MS / 60000 + ' 分钟仍未完成，已强制终止。');
  }
  throw error;
}
console.log('安装耗时 ' + ((Date.now() - installStart) / 1000).toFixed(1) + ' 秒');

// 4. 校验（顶层+嵌套；钉死集不得漂移，独立线必须按记录版本齐备）；产出构建版本清单
const actual = {};
for (const pattern of ['node_modules/@deepseek-ai/*/package.json', 'node_modules/*/*/node_modules/@deepseek-ai/*/package.json']) {
  for (const p of globSync(pattern)) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      actual[m.name] = m.version;
    } catch { /* 忽略坏包 */ }
  }
}
const drift = [...pinnable].filter((name) => actual[name] !== undefined && actual[name] !== V).map((name) => name + '@' + actual[name]);
if (drift.length > 0) {
  console.error('钉死失败，仍漂移: ' + drift.join(', '));
  process.exit(1);
}
const missingPeers = Object.keys(requiredPeers).filter((n) => actual[n] !== requiredPeers[n]).map((n) => n + '@' + requiredPeers[n] + (actual[n] ? '（实际 ' + actual[n] + '）' : '（缺失）'));
if (missingPeers.length > 0) {
  console.error('仅以 peer 出现的家族包未按预期安装: ' + missingPeers.join(', '));
  process.exit(1);
}
const missingIndependent = [...independent.entries()].filter(([n, v]) => actual[n] !== v).map(([n, v]) => n + '@' + v + (actual[n] ? '（实际 ' + actual[n] + '）' : '（缺失）'));
if (missingIndependent.length > 0) {
  console.error('独立版本线未按记录版本安装: ' + missingIndependent.join(', '));
  process.exit(1);
}
const report = {
  tag: V,
  pinnedCount: [...pinnable].filter((n) => actual[n] === V).length,
  pinned: Object.fromEntries([...pinnable].filter((n) => actual[n] === V).map((n) => [n, V])),
  independent: Object.fromEntries(independent),
};
writeFileSync('upstream-versions.json', JSON.stringify(report, null, 2) + '\n');
console.log('版本线钉死完成：' + report.pinnedCount + ' 个包锁定 ' + V + '；独立版本线 ' + independent.size + ' 个；peer 显式补齐 ' + Object.keys(requiredPeers).length + ' 个；清单见 upstream-versions.json');