// 录制 pin-upstream.mjs 回放所需的 registry fixture。
//
// 为什么是投影而不是原始 packument：脚本对每个包只读三样东西——versions 的键列表、
// versions[tagVersion]（同版本线包用）、versions[latestStable]（独立版本线包在 BFS
// 途中扩展依赖边用）。只存这三样，276 个包的 fixture 才小到可以入库；存原始
// abbreviated packument 会把 dist、engines、全部历史版本的依赖都带进来。
//
// 用法: node shell/scripts/lib/record-pin-fixture.mjs <tag-version> <out.json>
//       [registry-base-url]
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

// 只保留脚本会读到的字段。
function project(name, meta) {
  const versions = meta?.versions ?? {};
  const keys = Object.keys(versions);
  const wanted = new Set([tagVersion, latestStable(keys)].filter((v) => v !== undefined));
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
  return { name, versions: keys, manifests };
}

const captured = new Map();
const { pinnable, publishedByPackage } = await walkFamilyClosure(ROOT_PACKAGE, tagVersion, packument, {
  pool: POOL,
  onVisit: (name, meta) => { if (!captured.has(name)) captured.set(name, project(name, meta)); },
});

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
