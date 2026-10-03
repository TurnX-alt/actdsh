// 录制 pin-upstream.mjs 回放所需的 registry fixture。
//
// 为什么是投影而不是原始 packument：脚本对每个包只读四样东西——versions 的键列表、
// versions[tagVersion]（同版本线包用）、versions[latestStable]（独立版本线包在 BFS
// 途中扩展依赖边用）、dist-tags（选版时读上游的 dsh-* 发布专属 tag，ADR 0002）、
// 以及定点迭代收敛后真正读过的那些版本的 manifest（ADR 0001 的迭代路径；缺了它，回放会
// 拿到空 manifest 而「离线可证」变成假的确定）。
// 只存这四样，280 个包的 fixture 才小到可以入库；存原始 abbreviated packument 会把
// dist、engines、全部历史版本的依赖都带进来。
//
// 用法: node shell/scripts/lib/record-pin-fixture.mjs <tag-version> <out.json>
//       [registry-base-url]
//
// 录制策略（#30 的结论）：**按 tag 追加，绝不就地重写。**
// 同一 tag 在不同时刻录出来的内容并不相同——2026-09-29 真实发布把 libreoffice-kit 装成
// 0.1.2（^0.1.1 当时 admits 的最高值），今天重录同一个 tag 得到 0.1.3。就地覆盖会让
// 「回放与那次发布一致」这条断言无声失效，所以基线一旦落盘就不可变。
//
// 保留哪几份：固定的 alpha.2 形状（精确锁回归的载体，见 pin-replay.test.mjs）+ 最新 tag 一份。
// 成本实测：录制 8 秒、单份 280-380 KB；上限由 fixtures.test.mjs 钉住。
// 触发点：probe-upstream.mjs 每天比对基线 tag 与实时 tag，落后时报警告。
import { writeFileSync } from 'node:fs';
import { latestStable, walkFamilyClosure } from './version-line.mjs';

const [, , tagVersion, outFile, registryArg] = process.argv;
if (!tagVersion || !outFile) {
  console.error('usage: node record-pin-fixture.mjs <tag-version> <out.json> [registry-base-url]');
  process.exit(2);
}
const REGISTRY = (registryArg ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const ROOT_PACKAGE = '@deepseek-ai/dsh';
const POOL = 12;

async function packument(name) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(REGISTRY + '/' + name.replace('/', '%2f'), {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('packument ' + res.status + ' for ' + name);
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('packument failed for ' + name);
}

// 只保留脚本会读到的字段。keep 是闭包定点迭代真正读过的版本集合——
// 少了它，回放会拿到空 manifest，于是「离线可证」变成假的确定。
function project(name, meta, keep) {
  const versions = meta?.versions ?? {};
  const keys = Object.keys(versions);
  const wanted = new Set([tagVersion, latestStable(keys), ...(keep ?? [])].filter((v) => v !== undefined));
  const manifests = {};
  for (const v of wanted) {
    const m = versions[v];
    if (m === undefined) continue;
    manifests[v] = {
      ...(m.dependencies === undefined ? {} : { dependencies: m.dependencies }),
      ...(m.peerDependencies === undefined ? {} : { peerDependencies: m.peerDependencies }),
      ...(m.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: m.peerDependenciesMeta }),
    };
  }
  return { name, versions: keys, manifests, distTags: meta?.['dist-tags'] ?? {} };
}

// 先攒原始元数据：投影要等闭包收敛完才知道读过哪些版本，onVisit 时机太早。
const raw = new Map();
const { pinnable, publishedByPackage, manifestVersionsRead } = await walkFamilyClosure(
  ROOT_PACKAGE, tagVersion, packument,
  { pool: POOL, onVisit: (name, meta) => { if (!raw.has(name)) raw.set(name, meta); } });
// 投影集 = 闭包迭代中真读过的版本。多存是浪费体积，少存会让回放拿到空 manifest 而假绿。
const captured = new Map();
for (const [name, meta] of raw) {
  const used = (manifestVersionsRead.get(name) ?? []).filter((v) => meta.versions?.[v] !== undefined);
  captured.set(name, project(name, meta, used));
}

const fixture = {
  tag: tagVersion,
  registry: REGISTRY,
  recordedAt: new Date().toISOString(),
  packageCount: captured.size,
  packages: Object.fromEntries([...captured.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(outFile, JSON.stringify(fixture, null, 1) + '\n');
console.log('已录制 ' + captured.size + ' 个包 -> ' + outFile
  + '（同版本线 ' + pinnable.size + '，独立线 ' + publishedByPackage.size + '）');
