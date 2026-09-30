// 回放基线的边界与落后判定。#30 要求「产物有大小与耗时上限」，这里把上限变成可失败的断言，
// 而不是写在注释里等人记得。录制耗时（实测 8 秒/287 包）不在这里断言——它依赖网络，
// 放进 CI 会变成随机红灯；由 record-pin-fixture.mjs 的注释与 #30 的记录承担。
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { newestReplayBaseline } from './version-line.mjs';

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.startsWith('pin-') && f.endsWith('.json'));

// 单份上限 512 KB：现存最大的一份是 377 KB（276 包的 alpha.2），留三成余量。
// 投影只存 versions 的键与两个 manifest，正常增长远碰不到这条线；碰到就说明录制方式
// 退化成存原始 packument，那才是真问题。
const PER_FILE_CAP = 512 * 1024;
// 目录上限 1.5 MB：策略是「固定 alpha.2 形状 + 最新 tag 一份」，两份的量级。
// 超出即说明基线在被无限累积而不是轮换。
const DIR_CAP = 1536 * 1024;

test('fixture 集合存在且按 tag 命名', () => {
  assert.ok(files.length >= 2, '至少要有一份精确锁形状与一份当前图，实际 ' + files.join(', '));
  for (const f of files) {
    assert.match(f, /^pin-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.json$/, f + ' 命名不合规范');
  }
});

test('每份 fixture 不超过体积上限', () => {
  for (const f of files) {
    const size = statSync(DIR + f).size;
    assert.ok(size <= PER_FILE_CAP, f + ' 达 ' + size + ' B，超过上限 ' + PER_FILE_CAP);
  }
});

test('fixture 目录总体积不超过上限（防止基线无限累积）', () => {
  const total = files.reduce((sum, f) => sum + statSync(DIR + f).size, 0);
  assert.ok(total <= DIR_CAP, '合计 ' + total + ' B，超过上限 ' + DIR_CAP + '；应轮换而不是叠加');
});

test('alpha.2 那份必须保留：它是 ADR 0001 精确锁回归的唯一载体', () => {
  assert.ok(files.includes('pin-0.1.7-alpha.2.json'),
    '删掉 alpha.2 基线等于删掉「独立线被精确锁到旧版本」这一形态的回归测试');
});

// ---- newestReplayBaseline ----

test('基线 tag 与实时 tag 相同才算不落后', () => {
  assert.deepEqual(newestReplayBaseline(['pin-0.2.0-rc.2.json'], '0.2.0-rc.2'),
    { newest: '0.2.0-rc.2', lagging: false, count: 1 });
});

test('基线落后时报 lagging，并给出最新的那一份', () => {
  const r = newestReplayBaseline(['pin-0.1.7-alpha.2.json', 'pin-0.2.0-rc.1.json'], '0.2.0-rc.2');
  assert.deepEqual(r, { newest: '0.2.0-rc.1', lagging: true, count: 2 });
});

// 负控制：显式拿历史 tag 跑探针时，基线比它新，此时报「落后」是说反话。
test('基线比实时 tag 更新时不报落后', () => {
  assert.deepEqual(newestReplayBaseline(['pin-0.2.0-rc.2.json'], '0.1.7-alpha.2'),
    { newest: '0.2.0-rc.2', lagging: false, count: 1 });
});

// 负控制：只按文件名字典序会挑错——0.2.10 排在 0.2.9 之前。
// 这里刻意只断言主/次/修订号的数值序（compareVersions 文档承诺的部分）。
// prerelease 标识符的数值序它并未实现（'rc.10' 会被 localeCompare 判为小于 'rc.2'），
// 那是独立缺陷，见 https://github.com/TurnX-alt/actdsh/issues/34。
test('取最新基线用版本比较而非字符串序', () => {
  const r = newestReplayBaseline(['pin-0.2.10.json', 'pin-0.2.9.json'], '0.2.10');
  assert.equal(r.newest, '0.2.10');
  assert.equal(r.lagging, false);
});

test('目录里一份基线都没有时算落后，而不是静默通过', () => {
  assert.deepEqual(newestReplayBaseline(['readme.md'], '1.0.0'),
    { newest: null, lagging: true, count: 0 });
});

test('非基线命名的文件不参与判定', () => {
  assert.equal(newestReplayBaseline(['official-feed-win-x64.yml', 'pin-1.2.3.json'], '1.2.3').newest, '1.2.3');
});
