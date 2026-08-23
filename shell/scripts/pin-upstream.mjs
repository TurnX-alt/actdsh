// 版本线钉死：把依赖闭包内所有「与上游 tag 同版本线」的 @deepseek-ai/* 包钉到 tag 精确版本。
// 背景：dsh 主包按 tag 精确安装，但其 sibling 依赖以 ^x.y.z 发布区间解析，构建期会漂到
// 更新兼容版（实测 dsh@0.1.0-rc.8 的树里混入了 dsh-web-app@0.1.1-rc.2）。
// 上游发布纪律是「全部包同一版本线」，本脚本恢复该不变量；
// cordis/cosmokit/schemastery 等独立版本线的包（npm 上无此 tag 版本）自动豁免并记录。
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

// 1. 发现闭包内的家族包（顶层 + 一层嵌套兜底）
const names = new Set();
for (const pattern of ['node_modules/@deepseek-ai/*/package.json', 'node_modules/*/*/node_modules/@deepseek-ai/*/package.json']) {
  for (const p of globSync(pattern)) {
    try { names.add(JSON.parse(readFileSync(p, 'utf8')).name); } catch { /* 忽略坏包 */ }
  }
}
console.log('闭包内 @deepseek-ai/* 包数: ' + names.size);

// 2. 并发查询 registry 精简元数据，判断版本线是否存在（约 200 个包，池化 12 路）
async function hasVersionLine(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2f');
  try {
    const res = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!res.ok) return false;
    const meta = await res.json();
    return Object.prototype.hasOwnProperty.call(meta.versions ?? {}, V);
  } catch {
    return false; // 网络异常按独立版本线处理（宁可豁免不可错钉）
  }
}
const sorted = [...names].sort();
const pinnable = [];
const independent = [];
for (let i = 0; i < sorted.length; i += POOL) {
  const chunk = sorted.slice(i, i + POOL);
  const flags = await Promise.all(chunk.map(hasVersionLine));
  chunk.forEach((name, j) => (flags[j] ? pinnable : independent).push(name));
}
// 主包必须钉死（它定义版本线；且 manifest 里的直接依赖须与 overrides 一致，否则 npm EOVERRIDE）
if (!pinnable.includes('@deepseek-ai/dsh')) {
  pinnable.push('@deepseek-ai/dsh');
  independent.splice(independent.indexOf('@deepseek-ai/dsh'), 1);
}
console.log('钉死 ' + pinnable.length + ' 个；独立版本线豁免 ' + independent.length + ' 个: ' + independent.join(', '));

const manifestPath = 'package.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// 直接依赖同步归位（残留旧 pin 会与 overrides 冲突）
if (manifest.dependencies?.['@deepseek-ai/dsh'] !== undefined) manifest.dependencies['@deepseek-ai/dsh'] = V;
manifest.overrides = {};
for (const name of pinnable) manifest.overrides[name] = V;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 3. 重新解析
execFileSync(NPM, ['install', '--no-audit', '--no-fund'], { stdio: 'inherit', ...NPM_OPTS });

// 4. 校验：钉死名单全部到位；产出构建版本清单
// 注意：钉死后 npm 可能把个别包折叠为嵌套安装或剪枝出闭包，故遍历顶层+嵌套；
// 不在树内的包视为已离开闭包（不算漂移）。
const actual = {};
for (const pattern of ['node_modules/@deepseek-ai/*/package.json', 'node_modules/*/*/node_modules/@deepseek-ai/*/package.json']) {
  for (const p of globSync(pattern)) {
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      actual[m.name] = m.version;
    } catch { /* 忽略坏包 */ }
  }
}
const drift = pinnable.filter(name => actual[name] !== undefined && actual[name] !== V).map(name => name + '@' + actual[name]);
if (drift.length > 0) {
  console.error('钉死失败，仍漂移: ' + drift.join(', '));
  process.exit(1);
}
const report = {
  tag: V,
  pinnedCount: pinnable.length,
  pinned: Object.fromEntries(pinnable.map(n => [n, actual[n]])),
  independent: Object.fromEntries(independent.filter(n => actual[n]).map(n => [n, actual[n]])),
};
writeFileSync('upstream-versions.json', JSON.stringify(report, null, 2) + '\n');
console.log('版本线钉死完成：' + pinnable.length + ' 个包全部锁定 ' + V + '；清单见 upstream-versions.json');
