// 卡片构造与通道快照差异的纯函数测试。#29 的价值全在「差异」这一侧——
// 探针自己是绿的，通知必须由快照比对产生，所以比对错了就是漏报或骚扰。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoSecrets,
  buildAlertCard,
  buildChannelChangeCard,
  buildFailureCard,
  diffSnapshots,
  snapshotOf,
} from './feishu-card.mjs';

const threeTargets = [
  { target: 'win-x64', present: true, version: '0.2.0-rc.2', declaredSize: 289313640, releaseDate: '2026-09-29T10:35:27.666Z' },
  { target: 'mac-arm64', present: true, version: '0.2.0-rc.2', declaredSize: 374053565, releaseDate: '2026-09-29T10:18:12.232Z' },
  { target: 'mac-x64', present: true, version: '0.2.0-rc.2', declaredSize: 390853725, releaseDate: '2026-09-29T10:21:51.104Z' },
];

test('快照逐字节相同时无差异，因此不发通知', () => {
  const a = snapshotOf(threeTargets, '2026-10-02T00:00:00Z');
  const b = snapshotOf(threeTargets, '2026-10-03T00:00:00Z');
  assert.deepEqual(diffSnapshots(a, b), []);
});

test('observedAt 本身不算语义变化（否则每天都骚扰一次）', () => {
  const a = snapshotOf(threeTargets, '2026-10-02T00:00:00Z');
  const b = snapshotOf(threeTargets, '2026-10-09T00:00:00Z');
  assert.equal(diffSnapshots(a, b).length, 0);
});

// 2026-10-02 的真实事件：mac-x64 从 404 变成在架。当时没有任何通知说到这件事。
test('缺席变在架被识别为 appeared，并带上新版本', () => {
  const before = snapshotOf([
    ...threeTargets.slice(0, 2),
    { target: 'mac-x64', present: false },
  ], '2026-09-25T00:00:00Z');
  const after = snapshotOf(threeTargets, '2026-10-02T00:00:00Z');
  assert.deepEqual(diffSnapshots(before, after),
    [{ target: 'mac-x64', kind: 'appeared', from: null, to: '0.2.0-rc.2' }]);
});

test('在架变缺席同样被抓到（通道下架比新增更值得知道）', () => {
  const before = snapshotOf(threeTargets, 'x');
  const after = snapshotOf([
    threeTargets[0], threeTargets[1],
    { target: 'mac-x64', present: false },
  ], 'y');
  const changes = diffSnapshots(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'disappeared');
  assert.equal(changes[0].to, null);
});

test('版本、声明大小、发布时间各自单独成一条差异', () => {
  const before = snapshotOf(threeTargets, 'x');
  const moved = threeTargets.map((r) => ({
    ...r,
    version: '0.2.0-rc.3',
    declaredSize: r.declaredSize + 1,
    releaseDate: '2026-10-03T00:00:00.000Z',
  }));
  const changes = diffSnapshots(before, snapshotOf(moved, 'y'));
  assert.equal(changes.length, 9);
  assert.deepEqual([...new Set(changes.map((c) => c.kind))].sort(), ['declaredSize', 'releaseDate', 'version']);
});

test('首次运行只报 first-snapshot，卡片层把它折叠成不发通知', () => {
  const changes = diffSnapshots(null, snapshotOf(threeTargets, 'x'));
  assert.deepEqual(changes, [{ target: '*', kind: 'first-snapshot', from: null, to: 'x' }]);
  assert.equal(buildChannelChangeCard(changes, { repo: 'TurnX-alt/actdsh' }), null);
});

test('卡片里出现目标名与「绿但变了」这句话', () => {
  const card = buildChannelChangeCard(
    [{ target: 'mac-x64', kind: 'appeared', from: null, to: '0.2.0-rc.2' }],
    { repo: 'TurnX-alt/actdsh', observedAt: '2026-10-02T08:00:00Z', runUrl: 'https://github.com/TurnX-alt/actdsh/actions/runs/1' },
  );
  assert.equal(card.msg_type, 'interactive');
  assert.equal(card.card.schema, '2.0');
  assert.equal(card.card.header.template, 'orange');
  const text = JSON.stringify(card);
  assert.match(text, /mac-x64/);
  assert.match(text, /从缺席变为在架/);
  assert.match(text, /绿灯不会告诉你/);
});

// 自定义机器人是单向的：一旦混进 callback / form，卡片在飞书里会渲染成不可用控件。
test('webhook 卡片里不得出现 callback、form 或输入控件', () => {
  for (const card of [
    buildChannelChangeCard([{ target: 'win-x64', kind: 'version', from: 'a', to: 'b' }], { repo: 'r' }),
    buildFailureCard({ workflow: '桌面版发布', job: '构建并验证 windows-x64', step: '版本线钉死（release 纯度）', excerpt: 'boom', runId: '1', event: 'schedule', branch: 'main' }, { repo: 'r' }),
  ]) {
    const text = JSON.stringify(card);
    assert.doesNotMatch(text, /"callback"/, 'webhook 卡不得含 callback 行为');
    assert.doesNotMatch(text, /"form"/);
    assert.doesNotMatch(text, /"name":/);
  }
});

test('按钮一律带四端 URL，缺一端就会在某些客户端点了没反应', () => {
  const card = buildFailureCard({
    workflow: 'w', job: 'j', step: 's', excerpt: 'e', runId: '1', event: 'schedule', branch: 'main',
    runUrl: 'https://github.com/x/y/actions/runs/1',
  }, { repo: 'x/y' });
  const button = card.card.body.elements.find((e) => e.tag === 'button');
  assert.equal(button.behaviors[0].type, 'open_url');
  assert.deepEqual(Object.keys(button.behaviors[0]).sort(), ['android_url', 'default_url', 'ios_url', 'pc_url', 'type']);
});

test('没有 runUrl 时不放按钮，而不是放一个空链接', () => {
  const card = buildFailureCard({ workflow: 'w', job: 'j', step: 's', excerpt: 'e', runId: '1', event: 'schedule', branch: 'main' }, { repo: 'r' });
  assert.equal(card.card.body.elements.some((e) => e.tag === 'button'), false);
});

test('未知告警级别直接抛错，不悄悄用默认色', () => {
  assert.throws(() => buildAlertCard({ level: 'info', title: 't', summary: 's' }), /未知告警级别/);
});

// 通知内容里最常漏的一项就是 webhook 本身被回显进卡片正文。
test('卡片含 webhook 地址时拒绝发送', () => {
  const secret = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaa-bbbb';
  const card = buildAlertCard({ level: 'channel', title: 't', summary: secret });
  assert.throws(() => assertNoSecrets(card, [secret]), /拒绝发送/);
  assert.doesNotThrow(() => assertNoSecrets(buildAlertCard({ level: 'channel', title: 't', summary: '正常内容' }), [secret]));
});

test('短于 9 字符的条目不参与脱敏，避免误伤正常文本', () => {
  assert.doesNotThrow(() => assertNoSecrets(buildAlertCard({ level: 'channel', title: 't', summary: 'run 1234567890' }), ['12345']));
});
