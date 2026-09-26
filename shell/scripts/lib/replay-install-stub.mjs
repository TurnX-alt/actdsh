// 回放用的 npm install 替身：按 fixture 的依赖图物化一棵 node_modules 树。
//
// 这是一个独立的 npm 行为模型，只复用 version-line.mjs 里已被单测独立覆盖的
// 区间求值原语；提升/嵌套的判定自己写。若直接复用 pin-upstream 的判定逻辑，
// 回放就只是把脚本自己的结论再喂回给它，测不出任何东西。
//
// 模型规则（与 npm 的提升行为一致，且足以覆盖已观察到的依赖形态）：
//   - manifest.overrides 里的包无条件用覆盖版本；
//   - 顶层尚未安装该包时提升上去；
//   - 顶层已装且其版本满足当前依赖方声明的区间时复用；
//   - 否则嵌套装到依赖方自己的 node_modules 下。
// 通过 PIN_REPLAY_FIXTURE 指定 fixture；cwd 必须是已写好 package.json 的安装根。
// 若设置了 PIN_REPLAY_CORRUPT=<包名>，则把该包的顶层版本改写成 PIN_REPLAY_CORRUPT_VERSION，
// 用于制造「纯度闸门必须变红」的负控制。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, latestStable, satisfiesRange } from './version-line.mjs';

const cwd = process.cwd();
const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(process.env.PIN_REPLAY_FIXTURE, 'utf8'));
const packages = fixture.packages;
const overrides = manifest.overrides ?? {};

function knownVersions(name) {
  return packages[name]?.versions ?? [];
}

function pickVersion(name, declared) {
  if (overrides[name] !== undefined) return overrides[name];
  const versions = knownVersions(name);
  if (versions.length === 0) return declared;
  let range = declared;
  try {
    const ok = versions.filter((v) => satisfiesRange(v, range));
    if (ok.length > 0) return latestStable(ok);
  } catch {
    // fixture 里出现未支持的区间形态时退回最高稳定版，让脚本的闸门去暴露问题，
    // 而不是让替身先崩掉。
  }
  return latestStable(versions);
}

const topLevel = new Map();

function writePackage(dir, name, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }, null, 2) + '\n');
}

function installAt(name, version, hostDir) {
  const dir = hostDir === undefined
    ? join(cwd, 'node_modules', name)
    : join(hostDir, 'node_modules', name);
  writePackage(dir, name, version);
  return dir;
}

// 广度优先安装：先满足 package.json 声明的根依赖，再顺着 fixture 的依赖边下探。
const pending = [];
for (const [name, declared] of Object.entries(manifest.dependencies ?? {})) {
  pending.push({ name, range: declared, hostDir: undefined });
}

while (pending.length > 0) {
  const { name, range, hostDir } = pending.shift();
  let version;
  let dir;
  if (hostDir === undefined) {
    version = pickVersion(name, range);
    topLevel.set(name, version);
    dir = installAt(name, version, undefined);
  } else if (topLevel.has(name) && satisfiesQuietly(topLevel.get(name), range)) {
    continue; // 顶层副本已满足该依赖方的声明，npm 会复用它
  } else if (!topLevel.has(name)) {
    version = pickVersion(name, range);
    topLevel.set(name, version);
    dir = installAt(name, version, undefined);
  } else {
    version = pickVersion(name, range);
    dir = installAt(name, version, hostDir);
  }

  const deps = packages[name]?.manifests?.[version]?.dependencies ?? {};
  const peers = packages[name]?.manifests?.[version]?.peerDependencies ?? {};
  const meta = packages[name]?.manifests?.[version]?.peerDependenciesMeta ?? {};
  for (const [dep, depRange] of Object.entries(deps)) {
    pending.push({ name: dep, range: depRange, hostDir: dir });
  }
  // legacy peer 解析不会自动装 peer，故替身也不装；只有 optional 之外的 peer
  // 在被显式声明进 dependencies 时才会进入上面的根依赖队列。
  void peers;
  void meta;
}

function satisfiesQuietly(version, range) {
  try {
    return satisfiesRange(version, range);
  } catch {
    return false;
  }
}

// 负控制注入点：把某个包的顶层版本改写成错误值，纯度闸门必须发现它。
const corrupt = process.env.PIN_REPLAY_CORRUPT;
if (corrupt !== undefined && corrupt !== '') {
  const version = process.env.PIN_REPLAY_CORRUPT_VERSION ?? '0.0.0-corrupt';
  writePackage(join(cwd, 'node_modules', corrupt), corrupt, version);
  console.log('[replay-stub] 已注入漂移: ' + corrupt + '@' + version);
}

// 负控制注入点之二：在任意深度塞一份错误版本的副本，用来验证树扫描真的递归下探。
// 格式 <相对 cwd 的目录>|<包名>|<版本>，例如
//   node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/x/node_modules|@deepseek-ai/dsh-base|0.1.5
const nest = process.env.PIN_REPLAY_NEST;
if (nest !== undefined && nest !== '') {
  const [relDir, name, version] = nest.split('|');
  if (relDir === undefined || name === undefined || version === undefined) {
    throw new Error('[replay-stub] PIN_REPLAY_NEST 需要 <目录>|<包名>|<版本> 三段，收到: ' + nest);
  }
  writePackage(join(cwd, relDir, name), name, version);
  console.log('[replay-stub] 已注入深层嵌套副本: ' + name + '@' + version + ' @ ' + relDir);
}

const sorted = [...topLevel.entries()].sort(([a], [b]) => compareVersions(a, b) || a.localeCompare(b));
console.log('[replay-stub] 物化 ' + sorted.length + ' 个顶层包（取代 npm install）');
