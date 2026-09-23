import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDependencies,
  buildOverrides,
  buildReport,
  checkIndependentVersions,
  checkPinnedPurity,
  checkRequiredPeers,
  chooseIndependentVersion,
  classifyPackage,
  computeRequiredPeers,
  compareVersions,
  declaredRanges,
  familyEdges,
  highestSatisfying,
  indexInstalledTree,
  isFamilyPackage,
  isPeerOnly,
  latestStable,
  nestingDepth,
  parseVersion,
  resolveIndependentVersions,
  satisfiesRange,
} from './version-line.mjs';

const TAG = '0.1.7-alpha.2';
const TOP = 'node_modules/@deepseek-ai/';
const LOK = '@deepseek-ai/libreoffice-kit';
const OFFICE = '@deepseek-ai/dsh-office-to-pdf';

// 构造一条安装树记录。nestedIn 为空表示顶层副本，否则给出宿主包名。
function entry(name, version, nestedIn) {
  const leaf = name.split('/')[1];
  const relativePath = nestedIn === undefined
    ? `${TOP}${leaf}/package.json`
    : `${TOP}${nestedIn.split('/')[1]}/node_modules/@deepseek-ai/${leaf}/package.json`;
  return { name, version, relativePath };
}

// 独立版本线记录，形状与 resolveIndependentVersions 的输出一致。
function indep(version, ranges = [], declared = false) {
  return { version, ranges, declared };
}

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
  assert.equal(latestStable(['0.0.1', '0.0.2-rc4', '0.0.1-2', '0.0.3', '0.0.4', '0.1.0']), '0.1.0');
});

test('latestStable 全是 prerelease 时退回最高 prerelease', () => {
  assert.equal(latestStable(['1.0.0-rc.1', '1.0.0-rc.2']), '1.0.0-rc.2');
});

// ---- 版本区间 ----

test('satisfiesRange 处理精确版', () => {
  assert.ok(satisfiesRange('0.0.1', '0.0.1'));
  assert.ok(!satisfiesRange('0.1.0', '0.0.1'));
});

test('satisfiesRange 处理 ~ 只放开 patch', () => {
  assert.ok(satisfiesRange('4.0.4', '~4.0.4'));
  assert.ok(satisfiesRange('4.0.9', '~4.0.4'));
  assert.ok(!satisfiesRange('4.1.0', '~4.0.4'));
  assert.ok(!satisfiesRange('4.0.3', '~4.0.4'));
});

test('satisfiesRange 处理 ^ 的三档 0.x 规则', () => {
  assert.ok(satisfiesRange('1.9.0', '^1.0.0'));
  assert.ok(!satisfiesRange('2.0.0', '^1.0.0'));
  // 0.Y.Z：^ 只放开 patch
  assert.ok(satisfiesRange('0.1.9', '^0.1.0'));
  assert.ok(!satisfiesRange('0.2.0', '^0.1.0'));
  // 0.0.Z：^ 锁死到该 patch
  assert.ok(satisfiesRange('0.0.3', '^0.0.3'));
  assert.ok(!satisfiesRange('0.0.4', '^0.0.3'));
});

test('satisfiesRange 放行通配形态', () => {
  assert.ok(satisfiesRange('9.9.9', '*'));
  assert.ok(satisfiesRange('9.9.9', 'latest'));
});

test('satisfiesRange 对未支持的形态响亮失败，而不是猜', () => {
  assert.throws(() => satisfiesRange('1.0.0', '>=1.0.0 <2.0.0'), /不支持的版本区间形态/);
  assert.throws(() => satisfiesRange('1.0.0', 'workspace:*'), /不支持的版本区间形态/);
});

test('highestSatisfying 取满足全部声明的最高版', () => {
  const published = ['0.0.1', '0.0.3', '0.0.4', '0.1.0'];
  assert.equal(highestSatisfying(published, ['0.0.1']), '0.0.1');
  assert.equal(highestSatisfying(published, ['^0.1.0']), '0.1.0');
  assert.equal(highestSatisfying(published, ['~0.0.1']), '0.0.4');
  assert.equal(highestSatisfying(published, ['~0.0.1', '0.0.3']), '0.0.3');
  assert.equal(highestSatisfying(published, ['9.9.9']), undefined);
});

test('chooseIndependentVersion 无声明时退回最新稳定版', () => {
  assert.equal(chooseIndependentVersion(['1.0.0', '1.2.0', '2.0.0-rc.1'], []), '1.2.0');
});

// ---- 分类与边 ----

test('classifyPackage：有 tag 版本即同版本线，并带回已发布版本', () => {
  const r = classifyPackage({ versions: { [TAG]: { dependencies: {} }, '0.1.0': {} } }, TAG);
  assert.equal(r.kind, 'pinnable');
  assert.equal(r.version, TAG);
  assert.deepEqual(r.published.sort(), ['0.1.0', TAG].sort());
});

test('classifyPackage：无 tag 版本即独立版本线', () => {
  const r = classifyPackage({ versions: { '0.0.1': {}, '0.1.0': {} } }, TAG);
  assert.equal(r.kind, 'independent');
  assert.equal(r.version, '0.1.0');
  assert.deepEqual(r.published, ['0.0.1', '0.1.0']);
});

test('classifyPackage：空 packument 不抛异常且 published 为空', () => {
  assert.equal(classifyPackage(undefined, TAG).kind, 'independent');
  assert.deepEqual(classifyPackage({}, TAG).published, []);
});

test('familyEdges 记录 dep 与 peer 边及其声明区间', () => {
  assert.deepEqual(familyEdges({
    dependencies: { '@deepseek-ai/dsh-base': '1.0.0', lodash: '4.0.0' },
    peerDependencies: { '@deepseek-ai/cordis': '~4.0.4', '@deepseek-ai/opt': '1.0.0' },
    peerDependenciesMeta: { '@deepseek-ai/opt': { optional: true } },
  }), [
    { name: '@deepseek-ai/dsh-base', kind: 'dep', optional: false, range: '1.0.0' },
    { name: '@deepseek-ai/cordis', kind: 'peer', optional: false, range: '~4.0.4' },
    { name: '@deepseek-ai/opt', kind: 'peer', optional: true, range: '1.0.0' },
  ]);
});

test('familyEdges 忽略非家族包', () => {
  assert.deepEqual(familyEdges({ dependencies: { lodash: '4.0.0' } }), []);
  assert.ok(isFamilyPackage('@deepseek-ai/dsh'));
  assert.ok(!isFamilyPackage('lodash'));
});

test('declaredRanges 只取 dep 边与非 optional peer 边', () => {
  const edges = new Map([['x', [
    { kind: 'dep', optional: false, range: '~1.0.0' },
    { kind: 'peer', optional: false, range: '^1.2.0' },
    { kind: 'peer', optional: true, range: '9.9.9' },
  ]]]);
  assert.deepEqual(declaredRanges('x', edges), ['~1.0.0', '^1.2.0']);
  assert.deepEqual(declaredRanges('absent', edges), []);
});

test('declaredRanges 去重，避免失败消息被上百条相同区间淹没', () => {
  const edges = new Map([['x', [
    { kind: 'peer', optional: false, range: '~4.0.4' },
    { kind: 'peer', optional: false, range: '~4.0.4' },
    { kind: 'dep', optional: false, range: '~4.0.4' },
    { kind: 'dep', optional: false, range: '^4.0.0' },
  ]]]);
  assert.deepEqual(declaredRanges('x', edges), ['~4.0.4', '^4.0.0']);
});

test('isPeerOnly 只在「无 dep 边且有非 optional peer 边」时为真', () => {
  assert.ok(isPeerOnly('a', new Map([['a', [{ kind: 'peer', optional: false }]]])));
  assert.ok(!isPeerOnly('b', new Map([['b', [{ kind: 'dep' }, { kind: 'peer', optional: false }]]])));
  assert.ok(!isPeerOnly('c', new Map([['c', [{ kind: 'peer', optional: true }]]])));
});

// ---- 独立版本线选版（ADR 0001）----

test('resolveIndependentVersions：alpha.2 的真实形态——精确锁 0.0.1 压过最新稳定版 0.1.0', () => {
  const edges = new Map([[LOK, [{ name: LOK, kind: 'dep', optional: false, range: '0.0.1' }]]]);
  const resolved = resolveIndependentVersions(
    new Map([[LOK, ['0.0.1', '0.0.3', '0.0.4', '0.1.0']]]),
    edges,
  );
  assert.deepEqual(resolved.get(LOK), { version: '0.0.1', ranges: ['0.0.1'], declared: false });
});

test('resolveIndependentVersions：rc.1 的 ^0.1.0 会选到 0.1.0', () => {
  const edges = new Map([[LOK, [{ name: LOK, kind: 'dep', optional: false, range: '^0.1.0' }]]]);
  const resolved = resolveIndependentVersions(
    new Map([[LOK, ['0.0.1', '0.1.0']]]),
    edges,
  );
  assert.equal(resolved.get(LOK).version, '0.1.0');
});

test('resolveIndependentVersions：peer-only 包标记为需显式声明', () => {
  const edges = new Map([['@deepseek-ai/cordis-plugin-group', [
    { name: '@deepseek-ai/cordis-plugin-group', kind: 'peer', optional: false, range: '~1.0.4' },
  ]]]);
  const resolved = resolveIndependentVersions(
    new Map([['@deepseek-ai/cordis-plugin-group', ['1.0.3', '1.0.4']]]),
    edges,
  );
  assert.deepEqual(resolved.get('@deepseek-ai/cordis-plugin-group'), {
    version: '1.0.4', ranges: ['~1.0.4'], declared: true,
  });
});

test('resolveIndependentVersions：区间容纳更高版本时取更高的那个', () => {
  const edges = new Map([[LOK, [{ name: LOK, kind: 'dep', optional: false, range: '~0.0.1' }]]]);
  const resolved = resolveIndependentVersions(
    new Map([[LOK, ['0.0.1', '0.0.3', '0.0.4', '0.1.0']]]),
    edges,
  );
  // ~0.0.1 容纳 0.0.1/0.0.3/0.0.4，但不容纳 0.1.0；取满足声明的最高版。
  assert.equal(resolved.get(LOK).version, '0.0.4');
});

test('resolveIndependentVersions：无版本可满足全部声明时响亮失败', () => {
  const edges = new Map([[LOK, [
    { kind: 'dep', optional: false, range: '0.0.1' },
    { kind: 'dep', optional: false, range: '0.1.0' },
  ]]]);
  assert.throws(
    () => resolveIndependentVersions(new Map([[LOK, ['0.0.1', '0.1.0']]]), edges),
    /没有任何已发布版本能同时满足声明区间/,
  );
});

// ---- peer 补齐 ----

test('computeRequiredPeers 含同版本线的 peer-only 包与独立线的 declared 包', () => {
  const edges = new Map([
    ['@deepseek-ai/peer-pinnable', [{ kind: 'peer', optional: false }]],
    ['@deepseek-ai/dep-pinnable', [{ kind: 'dep' }]],
  ]);
  const independent = new Map([
    ['@deepseek-ai/peer-indep', indep('1.0.4', ['~1.0.4'], true)],
    ['@deepseek-ai/dep-indep', indep('0.0.1', ['0.0.1'], false)],
  ]);
  assert.deepEqual(
    computeRequiredPeers(new Set(['@deepseek-ai/peer-pinnable', '@deepseek-ai/dep-pinnable']), independent, edges, TAG),
    { '@deepseek-ai/peer-pinnable': TAG, '@deepseek-ai/peer-indep': '1.0.4' },
  );
});

// ---- manifest 组装 ----

test('buildDependencies 只声明主包与 peer 补齐包，有 dep 边的独立线不声明', () => {
  const deps = buildDependencies(
    { lodash: '4.0.0', '@deepseek-ai/stale': '0.0.1' },
    TAG,
    { '@deepseek-ai/peer-only': '1.0.4' },
    '@deepseek-ai/dsh',
  );
  assert.deepEqual(deps, {
    lodash: '4.0.0',
    '@deepseek-ai/dsh': TAG,
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

test('indexInstalledTree 分开记录顶层与嵌套副本', () => {
  const installed = indexInstalledTree([
    entry(LOK, '0.1.0'),
    entry(LOK, '0.0.1', OFFICE),
  ]);
  assert.equal(installed.topLevel.get(LOK), '0.1.0');
  assert.deepEqual([...installed.nested.get(LOK)], ['0.0.1']);
});

// ---- 三处闸门 ----

// 负控制之一：2026-09-23 的真实故障输入。
// dsh-office-to-pdf 精确锁 libreoffice-kit@0.0.1，旧实现把顶层装成 0.1.0、
// 子树嵌套 0.0.1，再用按名索引的映射让嵌套值覆盖顶层值，于是误报。
// 采纳 ADR 0001 后顶层本就是 0.0.1，且判定只看顶层。
test('独立版本线：顶层满足声明区间时，嵌套旧副本不得判为失败', () => {
  const installed = indexInstalledTree([
    entry(LOK, '0.0.1'),
    entry(OFFICE, TAG),
  ]);
  assert.deepEqual(checkIndependentVersions(new Map([[LOK, indep('0.0.1', ['0.0.1'])]]), installed), []);
});

// 与上一条配对，证明闸门仍有鉴别力：不是把断言放宽，而是读对了值。
test('独立版本线：顶层版本不满足声明区间时仍须报错', () => {
  const installed = indexInstalledTree([entry(LOK, '0.1.0')]);
  const problems = checkIndependentVersions(new Map([[LOK, indep('0.0.1', ['0.0.1'])]]), installed);
  assert.deepEqual(problems, [`${LOK}@0.1.0（不满足声明区间 0.0.1）`]);
});

test('独立版本线：显式声明的 peer 补齐包必须等于选定版本', () => {
  const installed = indexInstalledTree([entry('@deepseek-ai/cordis-plugin-group', '1.0.3')]);
  const problems = checkIndependentVersions(
    new Map([['@deepseek-ai/cordis-plugin-group', indep('1.0.4', ['~1.0.4'], true)]]),
    installed,
  );
  assert.deepEqual(problems, ['@deepseek-ai/cordis-plugin-group@1.0.4（实际 1.0.3）']);
});

test('独立版本线：完全没装上时报告缺失', () => {
  const installed = indexInstalledTree([entry('@deepseek-ai/dsh', TAG)]);
  assert.deepEqual(
    checkIndependentVersions(new Map([[LOK, indep('0.0.1', ['0.0.1'])]]), installed),
    [`${LOK}@0.0.1（缺失）`],
  );
});

// 负控制之二：peer 补齐同样曾被嵌套副本覆盖。
test('peer 补齐：按顶层副本判定', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/cordis-plugin-group', '1.0.4'),
    entry('@deepseek-ai/cordis-plugin-group', '1.0.3', '@deepseek-ai/dsh-app-boot'),
  ]);
  assert.deepEqual(checkRequiredPeers({ '@deepseek-ai/cordis-plugin-group': '1.0.4' }, installed), []);
});

test('同版本线：嵌套副本偏离 tag 版本仍须报漂移（严格语义不变）', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    entry('@deepseek-ai/dsh-base', TAG),
    entry('@deepseek-ai/dsh-base', '0.1.6', '@deepseek-ai/dsh'),
  ]);
  assert.deepEqual(
    checkPinnedPurity(new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']), TAG, installed),
    ['@deepseek-ai/dsh-base@0.1.6'],
  );
});

test('同版本线：深层嵌套（3 层以上）的偏离也要被发现', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    {
      name: '@deepseek-ai/dsh-base',
      version: '0.1.5',
      relativePath: 'node_modules/@deepseek-ai/a/node_modules/@deepseek-ai/b/node_modules/@deepseek-ai/dsh-base/package.json',
    },
  ]);
  assert.deepEqual(
    checkPinnedPurity(new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']), TAG, installed),
    ['@deepseek-ai/dsh-base@0.1.5'],
  );
});

test('同版本线：全树一致时无漂移', () => {
  const installed = indexInstalledTree([entry('@deepseek-ai/dsh', TAG), entry('@deepseek-ai/dsh-base', TAG)]);
  assert.deepEqual(checkPinnedPurity(new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']), TAG, installed), []);
});

// ---- 构建版本清单 ----

test('buildReport 的 .independent 取顶层观测值，不是选版意图', () => {
  const installed = indexInstalledTree([
    entry('@deepseek-ai/dsh', TAG),
    entry(LOK, '0.0.1'),
  ]);
  const report = buildReport(TAG, new Set(['@deepseek-ai/dsh']), new Map([[LOK, indep('0.0.1', ['0.0.1'])]]), installed);
  assert.deepEqual(report, {
    tag: TAG,
    pinnedCount: 1,
    pinned: { '@deepseek-ai/dsh': TAG },
    independent: { [LOK]: '0.0.1' },
  });
});

test('buildReport 保持对外形状（release-desktop.yml 用 jq 读 .pinnedCount 与 .independent）', () => {
  const installed = indexInstalledTree([entry('@deepseek-ai/dsh', TAG), entry(LOK, '0.0.1')]);
  const report = buildReport(TAG, new Set(['@deepseek-ai/dsh']), new Map([[LOK, indep('0.0.1', ['0.0.1'])]]), installed);
  assert.deepEqual(Object.keys(report).sort(), ['independent', 'pinned', 'pinnedCount', 'tag']);
});
