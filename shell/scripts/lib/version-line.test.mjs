import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDependencies,
  buildOverrides,
  buildReport,
  checkIndependentVersions,
  checkPinnedPurity,
  checkRequiredPeers,
  classifyPackage,
  computeRequiredPeers,
  compareVersions,
  familyEdges,
  indexInstalledTree,
  isFamilyPackage,
  latestStable,
  nestingDepth,
  parseVersion,
} from './version-line.mjs';

const TAG = '0.1.7-alpha.2';
const TOP = 'node_modules/@deepseek-ai/';

// 构造一条安装树记录。nestedIn 为空表示顶层副本，否则给出宿主包名。
function entry(name, version, nestedIn) {
  const relativePath = nestedIn === undefined
    ? `${TOP}${name.split('/')[1]}/package.json`
    : `${TOP}${nestedIn.split('/')[1]}/node_modules/@deepseek-ai/${name.split('/')[1]}/package.json`;
  return { name, version, relativePath };
}

const LOK = '@deepseek-ai/libreoffice-kit';

// ---- 版本比较（现有行为特征化，不得回归）----

test('parseVersion 解析 release 与 prerelease', () => {
  assert.deepEqual(parseVersion('1.2.3'), { nums: [1, 2, 3], pre: '' });
  assert.deepEqual(parseVersion('0.1.7-alpha.2'), { nums: [0, 1, 7], pre: 'alpha.2' });
  assert.equal(parseVersion('not-a-version'), null);
});

test('compareVersions 让 stable 高于同号 prerelease', () => {
  assert.ok(compareVersions('0.1.7', '0.1.7-alpha.2') > 0);
  assert.ok(compareVersions('0.0.1', '0.0.1-2') > 0);
  assert.ok(compareVersions('0.1.0', '0.0.4') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('latestStable 跳过 prerelease，取最高稳定版', () => {
  const versions = ['0.0.1', '0.0.2-rc4', '0.0.1-2', '0.0.3', '0.0.4', '0.1.0'];
  assert.equal(latestStable(versions), '0.1.0');
});

test('latestStable 全是 prerelease 时退回最高 prerelease', () => {
  assert.equal(latestStable(['1.0.0-rc.1', '1.0.0-rc.2']), '1.0.0-rc.2');
});

// ---- 分类 ----

test('classifyPackage：有 tag 版本即同版本线', () => {
  const packument = { versions: { [TAG]: { dependencies: {} } } };
  const r = classifyPackage(packument, TAG);
  assert.equal(r.kind, 'pinnable');
  assert.equal(r.version, TAG);
});

test('classifyPackage：无 tag 版本即独立版本线，取最新稳定版', () => {
  const packument = { versions: { '0.0.1': {}, '0.1.0': {}, '0.2.0-rc.1': {} } };
  const r = classifyPackage(packument, TAG);
  assert.equal(r.kind, 'independent');
  assert.equal(r.version, '0.1.0');
});

test('classifyPackage：空 packument 不抛异常', () => {
  assert.equal(classifyPackage(undefined, TAG).kind, 'independent');
  assert.equal(classifyPackage({}, TAG).version, undefined);
});

test('familyEdges 区分 dep 与 peer，并标记 optional peer', () => {
  const edges = familyEdges({
    dependencies: { '@deepseek-ai/dsh-base': '1.0.0', lodash: '4.0.0' },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/optional-thing': '1.0.0' },
    peerDependenciesMeta: { '@deepseek-ai/optional-thing': { optional: true } },
  });
  assert.deepEqual(edges, [
    { name: '@deepseek-ai/dsh-base', kind: 'dep', optional: false },
    { name: '@deepseek-ai/cordis', kind: 'peer', optional: false },
    { name: '@deepseek-ai/optional-thing', kind: 'peer', optional: true },
  ]);
});

test('familyEdges 忽略非家族包', () => {
  assert.deepEqual(familyEdges({ dependencies: { lodash: '4.0.0' } }), []);
  assert.ok(isFamilyPackage('@deepseek-ai/dsh'));
  assert.ok(!isFamilyPackage('lodash'));
});

// ---- peer 补齐 ----

test('computeRequiredPeers 只补「仅以非 optional peer 出现」的包', () => {
  const edges = new Map([
    ['@deepseek-ai/peer-only', [{ kind: 'peer', optional: false }]],
    ['@deepseek-ai/has-dep', [{ kind: 'dep', optional: false }, { kind: 'peer', optional: false }]],
    ['@deepseek-ai/optional-peer', [{ kind: 'peer', optional: true }]],
  ]);
  const independent = new Map([
    ['@deepseek-ai/peer-only', '1.0.4'],
    ['@deepseek-ai/has-dep', '2.0.0'],
    ['@deepseek-ai/optional-peer', '3.0.0'],
  ]);
  assert.deepEqual(
    computeRequiredPeers(new Set(), independent, edges, TAG),
    { '@deepseek-ai/peer-only': '1.0.4' },
  );
});

// ---- manifest 组装 ----

test('buildDependencies 重建家族依赖、保留非家族依赖', () => {
  const deps = buildDependencies(
    { lodash: '4.0.0', '@deepseek-ai/stale': '0.0.1' },
    TAG,
    new Map([[LOK, '0.0.1']]),
    { '@deepseek-ai/peer-only': '1.0.4' },
    '@deepseek-ai/dsh',
  );
  assert.deepEqual(deps, {
    lodash: '4.0.0',
    '@deepseek-ai/dsh': TAG,
    [LOK]: '0.0.1',
    '@deepseek-ai/peer-only': '1.0.4',
  });
});

test('buildOverrides 只覆盖同版本线包，不含独立线', () => {
  assert.deepEqual(
    buildOverrides(new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']), TAG),
    { '@deepseek-ai/dsh': TAG, '@deepseek-ai/dsh-base': TAG },
  );
});

// ---- 安装树记账 ----

test('nestingDepth 按 node_modules 段数区分顶层与嵌套', () => {
  assert.equal(nestingDepth(`${TOP}dsh/package.json`), 1);
  assert.equal(nestingDepth(`${TOP}dsh/node_modules/@deepseek-ai/dsh-base/package.json`), 2);
});

// 负控制：2026-09-23 的真实故障输入。
// dsh-office-to-pdf@0.1.7-alpha.2 精确锁 libreoffice-kit@0.0.1，而当时 npm 最新稳定版
// 是 0.1.0，于是顶层装 0.1.0、子树嵌套 0.0.1。嵌套副本是包管理器的正常行为，
// 顶层与记录值一致就不该判失败。修复前此处会红。
test('独立版本线：顶层符合记录值时，嵌套旧副本不得判为失败', () => {
  const installed = indexInstalledTree([
    entry(LOK, '0.1.0'),
    entry('@deepseek-ai/dsh-office-to-pdf', TAG),
    entry(LOK, '0.0.1', '@deepseek-ai/dsh-office-to-pdf'),
  ]);
  assert.deepEqual(checkIndependentVersions(new Map([[LOK, '0.1.0']]), installed), []);
});

// 与上一条配对，证明闸门仍有鉴别力：不是把断言放宽，而是读对了值。
test('独立版本线：顶层版本与记录值不符时仍须报错', () => {
  const installed = indexInstalledTree([
    entry(LOK, '0.0.4'),
    entry(LOK, '0.0.1', '@deepseek-ai/dsh-office-to-pdf'),
  ]);
  const problems = checkIndependentVersions(new Map([[LOK, '0.1.0']]), installed);
  assert.deepEqual(problems, [`${LOK}@0.1.0（实际 0.0.4）`]);
});

test('独立版本线：完全没装上时报告缺失', () => {
  const installed = indexInstalledTree([entry('@deepseek-ai/dsh', TAG)]);
  assert.deepEqual(
    checkIndependentVersions(new Map([[LOK, '0.1.0']]), installed),
    [`${LOK}@0.1.0（缺失）`],
  );
});

test('peer 补齐：同样按顶层副本判定', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/cordis-plugin-group', '1.0.4'),
    entry('@deepseek-ai/cordis-plugin-group', '1.0.3', '@deepseek-ai/dsh-app-boot'),
  ]);
  assert.deepEqual(
    checkRequiredPeers({ '@deepseek-ai/cordis-plugin-group': '1.0.4' }, installed),
    [],
  );
});

test('同版本线：嵌套副本偏离 tag 版本仍须报漂移（严格语义不变）', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    entry('@deepseek-ai/dsh-base', TAG),
    entry('@deepseek-ai/dsh-base', '0.1.6', '@deepseek-ai/dsh'),
  ]);
  const problems = checkPinnedPurity(
    new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']),
    TAG,
    installed,
  );
  assert.deepEqual(problems, ['@deepseek-ai/dsh-base@0.1.6']);
});

test('同版本线：全树一致时无漂移', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    entry('@deepseek-ai/dsh-base', TAG),
  ]);
  assert.deepEqual(checkPinnedPurity(new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']), TAG, installed), []);
});

// ---- 构建版本清单 ----

test('buildReport 保持对外形状（release-desktop.yml 用 jq 读 .pinnedCount 与 .independent）', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    entry(LOK, '0.1.0'),
  ]);
  const report = buildReport(TAG, new Set(['@deepseek-ai/dsh']), new Map([[LOK, '0.1.0']]), installed);
  assert.deepEqual(report, {
    tag: TAG,
    pinnedCount: 1,
    pinned: { '@deepseek-ai/dsh': TAG },
    independent: { [LOK]: '0.1.0' },
  });
});
