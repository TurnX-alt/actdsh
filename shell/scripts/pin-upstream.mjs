// 版本线钉死（单阶段）：先经 registry 元数据算出与上游 tag 同版本线的家族包集合，
// 写入 overrides 后一次性安装 —— 解析器从起点即指向 tag 版本，
// 避免「先装再降级」在 npm prerelease 区间上的回溯性卡顿（rc.7 实测卡死超 60 分钟）。
// 独立版本线（cordis 等，无此 tag 版本）自动豁免并记录。
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

async function packument(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2f');
  const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('packument ' + res.status + ' for ' + name);
  return res.json();
}

// 1. 从主包出发 BFS：仅沿「有 tag 版本线」的包扩展；独立版本线记入豁免
const pinnable = new Set(['@deepseek-ai/dsh']);
const independent = new Set();
const queue = ['@deepseek-ai/dsh'];
while (queue.length > 0) {
  const chunk = queue.splice(0, POOL);
  const metas = await Promise.all(chunk.map(async (name) => {
    try { return await packument(name); } catch { return null; }
  }));
  for (let i = 0; i < chunk.length; i += 1) {
    const meta = metas[i];
    if (meta === null || !meta.versions || !meta.versions[V]) {
      independent.add(chunk[i]);
      continue;
    }
    for (const dep of Object.keys(meta.versions[V].dependencies ?? {})) {
      if (!dep.startsWith('@deepseek-ai/') || pinnable.has(dep) || independent.has(dep)) continue;
      pinnable.add(dep);
      queue.push(dep);
    }
  }
}
console.log('同版本线包 ' + pinnable.size + ' 个；独立版本线豁免 ' + independent.size + ' 个: ' + [...independent].sort().join(', '));

// 2. overrides 与主包归位（先清空，防残留旧 pin 冲突）
const manifestPath = 'package.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies = { ...(manifest.dependencies ?? {}), '@deepseek-ai/dsh': V };
manifest.overrides = {};
for (const name of pinnable) manifest.overrides[name] = V;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 3. 单次安装（解析器从起点即指向 tag 版本）
execFileSync(NPM, ['install', '--no-audit', '--no-fund'], { stdio: 'inherit', ...NPM_OPTS });

// 4. 校验（顶层+嵌套；树内缺失视为离开闭包）；产出构建版本清单
const actual = {};
for (const pattern of ['node_modules/@deepseek-ai/*/package.json', 'node_modules/*/*/node_modules/@deepseek-ai/*/package.json']) {
  for (const p of globSync(pattern)) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      actual[m.name] = m.version;
    } catch { /* 忽略坏包 */ }
  }
}
const drift = [...pinnable].filter(name => actual[name] !== undefined && actual[name] !== V).map(name => name + '@' + actual[name]);
if (drift.length > 0) {
  console.error('钉死失败，仍漂移: ' + drift.join(', '));
  process.exit(1);
}
const report = {
  tag: V,
  pinnedCount: [...pinnable].filter(n => actual[n] === V).length,
  pinned: Object.fromEntries([...pinnable].filter(n => actual[n] === V).map(n => [n, V])),
  independent: Object.fromEntries([...independent].filter(n => actual[n]).map(n => [n, actual[n]])),
};
writeFileSync('upstream-versions.json', JSON.stringify(report, null, 2) + '\n');
console.log('版本线钉死完成：' + report.pinnedCount + ' 个包锁定 ' + V + '；清单见 upstream-versions.json');
