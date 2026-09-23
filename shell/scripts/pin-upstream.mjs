// 版本线钉死（单阶段 + legacy 解析）：
// 1) 经 registry 元数据 BFS 出与上游 tag 同版本线的家族包闭包（dependencies + peerDependencies 双通道扩展），
//    无此 tag 版本的独立版本线包（cordis、schemastery 等）各自记录一个版本；
// 2) 主包 + 全部独立线包以精确版写入 dependencies，同版本线包以精确版写入 overrides；
// 3) npm install --legacy-peer-deps 一次性安装（带硬超时）。
// 为什么 --legacy-peer-deps：npm 严格模式对新版本线的全量解析要在 ~200 包、300+ 条 peer 边的图上
// 做 peer 推断，实测连续 60+ 分钟每秒一条「ERESOLVE overriding peer dependency」不收敛（alpha.2 实证，
// 直到 job 超时被杀）。legacy 模式跳过 peer 推断（实测 51 秒装完 492 包、0 条 ERESOLVE）；
// 代价是 npm 不再自动安装「仅以 peer 出现」的包——此前 --legacy-peer-deps 因 cordis-plugin-group
// 缺失被回退的根因——故本脚本把 peer 闭包内的独立版本线包全部显式写进 dependencies，
// 最终树与严格模式自动安装结果等价，且全程无 peer 推断。
//
// 本文件只负责 IO 与编排；分类、选版、校验判定全部在 ./lib/version-line.mjs 里，
// 以便离线、秒级、确定性地测试。术语见仓库根 CONTEXT.md，
// 独立版本线的选版依据见 docs/adr/0001-independent-version-line-follows-declared-ranges.md。
// 用法（cwd = shell/runtime）: node ../scripts/pin-upstream.mjs <tag-version>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import {
  buildDependencies,
  buildOverrides,
  buildReport,
  checkIndependentVersions,
  checkPinnedPurity,
  checkRequiredPeers,
  classifyPackage,
  computeRequiredPeers,
  familyEdges,
  indexInstalledTree,
} from './lib/version-line.mjs';

const V = process.argv[2];
if (!V) {
  console.error('usage: node ../scripts/pin-upstream.mjs <tag-version>');
  process.exit(2);
}
const ROOT_PACKAGE = '@deepseek-ai/dsh';
const SCOPE_DIR = '@deepseek-ai';
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

// 1. 从主包出发 BFS（dependencies + peerDependencies 双通道，池化拉取）。
const pinnable = new Set([ROOT_PACKAGE]);
const independent = new Map();
const edges = new Map();
const queue = [ROOT_PACKAGE];
while (queue.length > 0) {
  const chunk = queue.splice(0, POOL);
  const metas = await Promise.all(chunk.map(async (name) => {
    try { return await packument(name); } catch { return null; }
  }));
  for (let i = 0; i < chunk.length; i += 1) {
    const name = chunk[i];
    const meta = metas[i];
    if (meta === null) throw new Error('packument 三次重试仍失败: ' + name);
    const classified = classifyPackage(meta, V);
    if (classified.kind === 'pinnable') {
      pinnable.add(name);
    } else {
      pinnable.delete(name);
      // 家族包在 registry 上一个可用版本都没有（被撤包或废弃）。此时必须响亮失败：
      // 静默跳过会让安装包缺一个运行时核心包，而纯度闸门的意义正是不放过这种情况。
      if (classified.version === undefined) {
        throw new Error('家族包 ' + name + ' 在 registry 上没有任何可用版本，无法钉死版本线');
      }
      independent.set(name, classified.version);
    }
    for (const edge of familyEdges(classified.manifest)) {
      let list = edges.get(edge.name);
      if (list === undefined) edges.set(edge.name, list = []);
      list.push(edge);
      if (!pinnable.has(edge.name) && !independent.has(edge.name) && !queue.includes(edge.name)) queue.push(edge.name);
    }
  }
}
console.log('同版本线包 ' + pinnable.size + ' 个；独立版本线 ' + independent.size + ' 个: ' + [...independent.entries()].map(([n, v]) => n + '@' + v).sort().join(', '));

// 主包在 npm 上无此 tag 版本 = 上游该 release 未发布 npm 包（如 alpha 线只发 GitHub）：
// 提前以清晰文案失败，避免把不存在的版本写进 dependencies 后死在晦涩的 npm ETARGET。
if (!pinnable.has(ROOT_PACKAGE)) {
  console.error('npm 注册表不存在 ' + ROOT_PACKAGE + '@' + V + '：上游该 release 未发布 npm 包，无法钉死版本线。');
  process.exit(1);
}

// 2. 主包与独立线写入 dependencies、同版本线写入 overrides（家族依赖整体重建，防残留旧 pin 冲突）。
//    独立线只作精确依赖、不写 overrides：若某个依赖方需要其旧版本，npm 可在子树嵌套解析，
//    那是正常行为，校验按顶层副本判定（见 ADR 0001）。
const requiredPeers = computeRequiredPeers(pinnable, independent, edges, V);
const manifestPath = 'package.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies = buildDependencies(manifest.dependencies, V, independent, requiredPeers, ROOT_PACKAGE);
manifest.overrides = buildOverrides(pinnable, V);
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

// 4. 扫描安装树：递归覆盖任意嵌套深度。旧实现只用两条固定深度的 glob，
//    3 层以上的嵌套副本会被漏掉，而「同版本线全树必须等于 tag 版本」这个不变量要求覆盖全树。
function collectFamilyManifests(rootDir) {
  const found = [];
  const visit = (nmDir) => {
    let entries;
    try { entries = readdirSync(nmDir, { withFileTypes: true }); } catch { return; }
    const packageDirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const full = join(nmDir, e.name);
      if (!e.name.startsWith('@')) {
        packageDirs.push(full);
        continue;
      }
      let scoped;
      try { scoped = readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const s of scoped) {
        if (!s.isDirectory() && !s.isSymbolicLink()) continue;
        const pkgDir = join(full, s.name);
        packageDirs.push(pkgDir);
        if (e.name === SCOPE_DIR) {
          const pj = join(pkgDir, 'package.json');
          if (existsSync(pj)) found.push(pj);
        }
      }
    }
    for (const pkgDir of packageDirs) {
      const nested = join(pkgDir, 'node_modules');
      if (existsSync(nested)) visit(nested);
    }
  };
  visit(join(rootDir, 'node_modules'));
  return found;
}

const cwd = process.cwd();
const tree = [];
for (const pj of collectFamilyManifests(cwd)) {
  try {
    const m = JSON.parse(readFileSync(pj, 'utf8'));
    if (typeof m.name !== 'string' || typeof m.version !== 'string') continue;
    tree.push({ name: m.name, version: m.version, relativePath: relative(cwd, pj).split(sep).join('/') });
  } catch { /* 忽略坏包 */ }
}
const installed = indexInstalledTree(tree);

// 5. 校验：同版本线不得有任何副本漂移；peer 补齐与独立线按顶层副本判定。
const drift = checkPinnedPurity(pinnable, V, installed);
if (drift.length > 0) {
  console.error('钉死失败，仍漂移: ' + drift.join(', '));
  process.exit(1);
}
const missingPeers = checkRequiredPeers(requiredPeers, installed);
if (missingPeers.length > 0) {
  console.error('仅以 peer 出现的家族包未按预期安装: ' + missingPeers.join(', '));
  process.exit(1);
}
const missingIndependent = checkIndependentVersions(independent, installed);
if (missingIndependent.length > 0) {
  console.error('独立版本线未按记录版本安装: ' + missingIndependent.join(', '));
  process.exit(1);
}

const report = buildReport(V, pinnable, independent, installed);
writeFileSync('upstream-versions.json', JSON.stringify(report, null, 2) + '\n');
console.log('版本线钉死完成：' + report.pinnedCount + ' 个包锁定 ' + V + '；独立版本线 ' + independent.size + ' 个；peer 显式补齐 ' + Object.keys(requiredPeers).length + ' 个；清单见 upstream-versions.json');
