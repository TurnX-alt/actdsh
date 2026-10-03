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
  findUnpublishedFamilyMembers,
  highestSatisfying,
  indexInstalledTree,
  releaseDistTag,
  isFamilyPackage,
  isPeerOnly,
  latestStable,
  nestingDepth,
  parseVersion,
  resolveIndependentVersions,
  walkFamilyClosure,
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
  assert.deepEqual(resolved.get(LOK),
    { version: '0.0.1', ranges: ['0.0.1'], declared: false, chosenBy: 'declared-ranges' });
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
    version: '1.0.4', ranges: ['~1.0.4'], declared: true, chosenBy: 'declared-ranges',
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

// ---- 发布窗口判定（#32）----

const RC = '0.2.0-rc.2';
const ROOT = '@deepseek-ai/dsh';
const SETTINGS = '@deepseek-ai/dsh-client-ui-settings-account';
const CORDIS = '@deepseek-ai/cordis';
const demands = (name, range, kind = 'dep', optional = false) => new Map([[name, [{ name, kind, optional, range }]]]);

test('闭包完整时不报等待，否则每次正常发布都会空转', () => {
  const published = new Map([[ROOT, [RC]], [SETTINGS, ['0.2.0-rc.1', RC]]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, demands(SETTINGS, RC), RC), []);
});

test('家族包被精确声明为该版本却还没发布时列为等待，并带回它自己的最新版', () => {
  const published = new Map([[ROOT, [RC]], [SETTINGS, ['0.1.7-rc.2', '0.2.0-rc.1']]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, demands(SETTINGS, RC), RC),
    [{ name: SETTINGS, latest: '0.2.0-rc.1' }]);
});

test('独立版本线包缺该版本不算等待——它本来就不跟 tag 走', () => {
  const published = new Map([[ROOT, [RC]], [CORDIS, ['4.0.3', '4.0.4']]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, demands(CORDIS, '~4.0.4'), RC), []);
});

test('只经 optional peer 抵达的缺口不算等待，因为没人强制要求那个版本', () => {
  const published = new Map([[ROOT, [RC]], [SETTINGS, ['0.2.0-rc.1']]]);
  const edges = demands(SETTINGS, RC, 'peer', true);
  assert.deepEqual(findUnpublishedFamilyMembers(published, edges, RC), []);
});

test('非家族包即使被精确声明为该版本也不列入家族等待', () => {
  const published = new Map([[ROOT, [RC]], ['express', ['4.18.2']]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, demands('express', RC), RC), []);
});

test('家族包一个版本都没有发布过时列为等待，而不是崩在空列表上', () => {
  const published = new Map([[ROOT, [RC]], [SETTINGS, []]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, demands(SETTINGS, RC), RC),
    [{ name: SETTINGS, latest: '(无)' }]);
});

test('多个依赖方同声明一个缺失包时只列一次', () => {
  const published = new Map([[ROOT, [RC]], [SETTINGS, ['0.2.0-rc.1']]]);
  const edges = new Map([[SETTINGS, [
    { name: SETTINGS, kind: 'dep', optional: false, range: RC },
    { name: SETTINGS, kind: 'dep', optional: false, range: RC },
  ]]]);
  assert.deepEqual(findUnpublishedFamilyMembers(published, edges, RC),
    [{ name: SETTINGS, latest: '0.2.0-rc.1' }]);
});

// ---- #34：prerelease 必须按 semver 的标识符规则比，不能用字典序 ----

test('rc.10 高于 rc.2，alpha.10 高于 alpha.9（字典序会判反）', () => {
  assert.ok(compareVersions('0.2.0-rc.10', '0.2.0-rc.2') > 0);
  assert.ok(compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0);
  assert.ok(compareVersions('0.2.0-alpha.10', '0.2.0-alpha.9') > 0);
});

test('同号的 stable 仍高于任何 prerelease', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.9') > 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
});

test('数字标识符优先级低于字母标识符（semver 规则）', () => {
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-1') > 0);
});

test('前面标识符全相等时，少者更小', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-rc', '1.0.0-rc.2') < 0);
});

test('字母标识符按 ASCII 而非区域设置比较', () => {
  // localeCompare 在部分区域下会把大小写与连字符判成不同序；这里锁死为 ASCII 序。
  assert.ok(compareVersions('1.0.0-dev', '1.0.0-rc') < 0);
  assert.ok(compareVersions('1.0.0-rc', '1.0.0-dev') > 0);
});

test('点分形态下 latestStable 能选到 rc.10（家族的实际命名）', () => {
  // dsh 家族用 `0.1.7-rc.1` 这种点分形态，所以这才是本仓库会踩到的形状。
  const list = ['0.2.0-rc.4', '0.2.0-rc.5', '0.2.0-rc.9', '0.2.0-rc.10'];
  assert.equal([...list].sort(compareVersions).at(-1), '0.2.0-rc.10');
  assert.equal(latestStable(list), '0.2.0-rc.10');
});

test('无点的 rc10 按 ASCII 序排在 rc9 之前——这不是我们的缺陷，semver 亦如此', () => {
  // 标识符以点分隔；`rc10` 整体是一个字母数字标识符，按 ASCII 逐字符比，'1' < '9'。
  // 上游 libreoffice-kit 历史上用的正是 0.0.2-rc4…rc9 这种无点形态：若它将来发 rc10，
  // npm 自己的 semver 也会判它小于 rc9。记在这里，免得后人把它当 bug 「修」掉。
  const list = ['0.0.2-rc9', '0.0.2-rc10'];
  assert.equal([...list].sort(compareVersions).at(-1), '0.0.2-rc9');
});

test('两个 prerelease 完全相等时返回 0（不因为 split 产生假序）', () => {
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.2'), 0);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.10'), 0);
});

// —— 带预发布后缀的区间（2026-10-03 上游首次出现：dsh@0.2.1-alpha.1 声明 cordis ~4.0.5-alpha.1）——
// 原实现只认整数三段，于是探针在「新形态」上抛「不支持的形态」，把一次正常发布报成人工排查级别。

test('satisfiesRange 认得 ~X.Y.Z-预发布，并按 node-semver 的三元组规则放行候选', () => {
  assert.equal(satisfiesRange('4.0.5-alpha.1', '~4.0.5-alpha.1'), true, '下界自身必须满足');
  assert.equal(satisfiesRange('4.0.5-beta.2', '~4.0.5-alpha.1'), true, '同三元组、标识符更高的预发布也满足');
  assert.equal(satisfiesRange('4.0.5', '~4.0.5-alpha.1'), true, '同号稳定版高于其预发布');
  assert.equal(satisfiesRange('4.0.9', '~4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('4.0.4', '~4.0.5-alpha.1'), false, '低于下界');
  assert.equal(satisfiesRange('4.1.0', '~4.0.5-alpha.1'), false, '~ 只放开 patch');
  assert.equal(satisfiesRange('4.1.0-alpha.1', '~4.0.5-alpha.1'), false, '三元组不同的预发布不满足');
  assert.equal(satisfiesRange('4.0.6-alpha.1', '~4.0.5-alpha.1'), false,
    '4.0.6 的预发布不满足：区间没把候选面放开到那个三元组');
});

test('satisfiesRange 对 ^X.Y.Z-预发布放开整个主版本', () => {
  assert.equal(satisfiesRange('4.0.5-alpha.1', '^4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('4.9.0', '^4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('5.0.0', '^4.0.5-alpha.1'), false);
  assert.equal(satisfiesRange('4.0.4', '^4.0.5-alpha.1'), false);
});

test('satisfiesRange 认得不完整的 ~ / ^ 形态（~ 只锁到最后一个给定数字）', () => {
  assert.equal(satisfiesRange('4.9.9', '~4'), true);
  assert.equal(satisfiesRange('5.0.0', '~4'), false);
  assert.equal(satisfiesRange('4.0.9', '~4.0'), true);
  assert.equal(satisfiesRange('4.1.0', '~4.0'), false);
  assert.equal(satisfiesRange('4.5.0', '^4.0'), true);
  assert.equal(satisfiesRange('5.0.0', '^4.0'), false);
  assert.equal(satisfiesRange('0.0.9', '^0.0'), true);
  assert.equal(satisfiesRange('0.1.0', '^0.0'), false, '^0.0 没给补丁号时不锁成 0.0.z');
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true);
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false, '^0.0.z 只放开补丁');
  assert.equal(satisfiesRange('0.9.9', '^0'), true);
  assert.equal(satisfiesRange('1.0.0', '^0'), false);
});

test('satisfiesRange 仍然拒绝不认识的形态，不因为放宽就猜', () => {
  for (const bad of ['>=1.2.3', '<=2.0.0', '1.x', '4.*', '^4.0.0 || ^5.0.0', 'workspace:*', '~~1.2.3']) {
    assert.throws(() => satisfiesRange('1.2.3', bad), /不支持的版本区间形态/, '应当拒绝: ' + bad);
  }
});

// —— 上游的发布专属 dist-tag（ADR 0002）——

test('releaseDistTag 按上游实测命名：点全部换成连字符', () => {
  assert.equal(releaseDistTag('0.2.1-alpha.1'), 'dsh-0-2-1-alpha-1');
  assert.equal(releaseDistTag('0.2.0-rc.2'), 'dsh-0-2-0-rc-2');
  assert.equal(releaseDistTag('0.1.7-alpha.2'), 'dsh-0-1-7-alpha-2');
});

test('chooseIndependentVersion 优先采纳发布专属 tag，压过区间解', () => {
  const published = ['4.0.4', '4.0.5-alpha.1'];
  assert.equal(chooseIndependentVersion(published, ['~4.0.4'], '4.0.5-alpha.1'), '4.0.5-alpha.1');
  assert.equal(chooseIndependentVersion(published, ['~4.0.4'], undefined), '4.0.4');
});

test('发布 tag 指向一个 registry 上没有的版本时响亮失败，不退回区间解', () => {
  // 静默退回会假装「一切正常」，而真实情况是上游打了 tag 却没发布那个版本——
  // 或者我们的 packument 缓存滞后，两种都必须让人看见。
  assert.throws(() => chooseIndependentVersion(['4.0.4'], ['~4.0.4'], '4.0.5-alpha.9'),
    /registry 的已发布列表里没有它/);
});

test('resolveIndependentVersions 把 0.2.1-alpha.1 的 cordis 形状解成上游指定的版本', () => {
  const publishedByPackage = new Map([['@deepseek-ai/cordis', ['4.0.1', '4.0.4', '4.0.5-alpha.1']]]);
  const edges = new Map([['@deepseek-ai/cordis', [
    { name: '@deepseek-ai/cordis', kind: 'dep', optional: false, range: '~4.0.5-alpha.1' },
    // 闭包按 latestStable 的 manifest 收集边，于是混进了上一个稳定版的声明。
    { name: '@deepseek-ai/cordis', kind: 'peer', optional: false, range: '~4.0.4' },
  ]]]);
  const distTagsByPackage = new Map([['@deepseek-ai/cordis', { latest: '4.0.4', 'dsh-0-2-1-alpha-1': '4.0.5-alpha.1' }]]);
  const got = resolveIndependentVersions(publishedByPackage, edges, { tagVersion: '0.2.1-alpha.1', distTagsByPackage });
  assert.equal(got.get('@deepseek-ai/cordis').version, '4.0.5-alpha.1');
  assert.equal(got.get('@deepseek-ai/cordis').chosenBy, 'upstream-release-tag');
});

test('没有发布专属 tag 的独立线包仍按区间求解，并如实标出来源', () => {
  const publishedByPackage = new Map([['@deepseek-ai/x', ['1.0.0', '1.1.0', '1.2.0']]]);
  const edges = new Map([['@deepseek-ai/x', [
    { name: '@deepseek-ai/x', kind: 'dep', optional: false, range: '^1.0.0' },
  ]]]);
  const got = resolveIndependentVersions(publishedByPackage, edges,
    { tagVersion: '0.2.1-alpha.1', distTagsByPackage: new Map([['@deepseek-ai/x', { latest: '1.2.0' }]]) });
  assert.equal(got.get('@deepseek-ai/x').version, '1.2.0');
  assert.equal(got.get('@deepseek-ai/x').chosenBy, 'declared-ranges');
});

test('不传 tagVersion 时行为与 ADR 0001 时期完全一致（旧 fixture 不受影响）', () => {
  const publishedByPackage = new Map([['@deepseek-ai/x', ['1.0.0', '1.1.0']]]);
  const edges = new Map([['@deepseek-ai/x', [
    { name: '@deepseek-ai/x', kind: 'dep', optional: false, range: '~1.0.0' },
  ]]]);
  const got = resolveIndependentVersions(publishedByPackage, edges);
  assert.equal(got.get('@deepseek-ai/x').version, '1.0.0');
  assert.equal(got.get('@deepseek-ai/x').chosenBy, 'declared-ranges');
});

// —— 闭包定点迭代（ADR 0001 的选版机制补的那一环）——
// 这三条不依赖上游的 dsh-* tag：A 的价值正是「没有 tag 也应该对」。

// 造一个上游形状：根包精确要 newplugin@2.0.0-alpha.1；而 newplugin 的旧稳定版 1.9.0
// 声明 core ~1.0.0，它自己的 alpha 版声明 core ~1.1.0-alpha.1。
// 只读 latestStable 的 manifest 会得到互斥的 core 约束；迭代到定点后不该再有 1.0.0 那一条。
function makeRegistry(corePublished) {
  const pkgs = {
    '@deepseek-ai/dsh': {
      '2.0.0-alpha.1': { dependencies: { '@deepseek-ai/core': '~1.1.0-alpha.1', '@deepseek-ai/newplugin': '2.0.0-alpha.1' } },
    },
    '@deepseek-ai/newplugin': {
      '1.9.0': { dependencies: { '@deepseek-ai/core': '~1.0.0' } },
      '2.0.0-alpha.1': { dependencies: { '@deepseek-ai/core': '~1.1.0-alpha.1' } },
    },
    '@deepseek-ai/core': {},
  };
  return async (name) => {
    if (name === '@deepseek-ai/core') return { versions: Object.fromEntries(corePublished.map((v) => [v, {}])) };
    const versions = {};
    for (const [v, m] of Object.entries(pkgs[name] ?? {})) versions[v] = m;
    return { versions };
  };
}

test('闭包迭代到定点：过期 manifest 的区间不会留在约束集里（无 dist-tag 也成立）', async () => {
  const { pinnable, publishedByPackage, edges, chosenVersions, rounds } =
    await walkFamilyClosure('@deepseek-ai/dsh', '2.0.0-alpha.1', makeRegistry(['1.0.0', '1.0.9', '1.1.0-alpha.1', '1.1.0']));
  assert.equal(pinnable.has('@deepseek-ai/newplugin'), true, 'newplugin 发了 tag 版本即同版本线');
  const ranges = declaredRanges('@deepseek-ai/core', edges);
  assert.deepEqual(ranges, ['~1.1.0-alpha.1'], '不应再混进 1.9.0 那份 manifest 的 ~1.0.0');
  const independent = resolveIndependentVersions(publishedByPackage, edges, { tagVersion: '2.0.0-alpha.1' });
  assert.equal(independent.get('@deepseek-ai/core').version, '1.1.0', '稳定版存在时仍取稳定版');
  assert.ok(rounds >= 1, '至少跑过一轮');
  void chosenVersions;
});

test('定点迭代会随选定版本换 manifest：只剩预发布可用时解出预发布', async () => {
  const { edges, publishedByPackage } =
    await walkFamilyClosure('@deepseek-ai/dsh', '2.0.0-alpha.1', makeRegistry(['1.0.0', '1.0.9', '1.1.0-alpha.1']));
  const independent = resolveIndependentVersions(publishedByPackage, edges, { tagVersion: '2.0.0-alpha.1' });
  assert.equal(independent.get('@deepseek-ai/core').version, '1.1.0-alpha.1');
  assert.equal(independent.get('@deepseek-ai/core').chosenBy, 'declared-ranges', '没有 tag 时来源必须是区间');
});

test('区间互斥到无法收敛时响亮失败，而不是交一个半收敛的图给构建', async () => {
  // core 只有 1.0.x：定点上 newplugin 的 alpha 声明要 1.1.0-alpha.1，永远解不出。
  const { publishedByPackage, edges } =
    await walkFamilyClosure('@deepseek-ai/dsh', '2.0.0-alpha.1', makeRegistry(['1.0.0', '1.0.9']));
  assert.throws(
    () => resolveIndependentVersions(publishedByPackage, edges, { tagVersion: '2.0.0-alpha.1' }),
    /没有任何已发布版本能同时满足声明区间/,
  );
});

test('闭包上限可注入：一轮就停时未收敛必须抛错，不许静默交出自相矛盾的图', async () => {
  const fetch = makeRegistry(['1.0.0', '1.0.9', '1.1.0-alpha.1', '1.1.0']);
  const limited = await walkFamilyClosure('@deepseek-ai/dsh', '2.0.0-alpha.1', fetch, { pool: 2, maxRounds: 1 })
    .then(() => null)
    .catch((error) => error);
  assert.ok(limited instanceof Error, 'maxRounds=1 时第一轮还在扩图，应当判未收敛');
  assert.match(limited.message, /未收敛/);
  const full = await walkFamilyClosure('@deepseek-ai/dsh', '2.0.0-alpha.1', fetch, { pool: 2 });
  assert.ok(full.rounds >= 2, '同一张图放开轮数后应至少两轮才稳定');
});
