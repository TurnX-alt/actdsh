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
  excerptFromLog,
  runUrlFromEnv,
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

// —— 失败卡片里的日志摘录 ——
// 卡片不是日志查看器：只取脚本自己写下的 annotation 行，其余一律不进卡片。

test('只取 error/warning annotation，忽略周围噪声', () => {
  const log = [
    '官方桌面版通道（https://download.deepseek.com/dsh-desk/feeds/）：',
    '::group::install',
    '::error::win-x64：产物探测失败 fetch failed',
    'npm http fetch 200',
    '::warning::3 个家族包还没发布 0.2.0-rc.2，退出码 3 表示「等一轮」。',
    '::endgroup::',
  ].join('\n');
  const text = excerptFromLog(log);
  assert.match(text, /^❌ win-x64：产物探测失败 fetch failed$/m);
  assert.match(text, /^⚠️ 3 个家族包还没发布/m);
  assert.equal(text.includes('npm http fetch'), false);
  assert.equal(text.includes('::'), false);
});

test('annotation 的 file/line 参数作为位置信息保留', () => {
  const text = excerptFromLog('::error file=shell/scripts/pin-upstream.mjs,line=88::钉死失败');
  assert.equal(text, '❌ shell/scripts/pin-upstream.mjs:88 · 钉死失败');
});

test('没有 annotation 时指向 run，而不是猜一个原因', () => {
  const text = excerptFromLog('Downloading...\nUnpacking...\n');
  assert.match(text, /日志里没有脚本自己写下的诊断行/);
});

test('group/notice/空消息不是诊断行', () => {
  assert.match(excerptFromLog('::group::x\n::notice::看起来还行\n::error::\n'), /日志里没有/);
});

test('超出条数上限时折叠并如实报数', () => {
  const log = Array.from({ length: 9 }, (_, i) => '::error::第 ' + (i + 1) + ' 条').join('\n');
  const text = excerptFromLog(log, { maxNotes: 6 });
  assert.equal(text.split('\n').filter((l) => l.startsWith('❌')).length, 6);
  assert.match(text, /另有 3 条诊断行/);
});

test('单条过长时截断，卡片不会被一条消息撑爆', () => {
  const text = excerptFromLog('::error::' + 'x'.repeat(500), { maxChars: 200 });
  assert.ok(text.length < 220, 'excerpt 应被截到 200 字符附近');
  assert.match(text, /…$/);
});

// —— run 链接 ——
// 卡片上的按钮点了要能到地方。三处调用点以前各自拼字符串，拼出过 "undefined/x/actions/runs/"
// 这种非空但无效的链接；收敛成一个函数并钉住缺项时的行为。
test('环境变量齐全时才拼出 run 链接', () => {
  assert.equal(
    runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com/', GITHUB_REPOSITORY: 'a/b', GITHUB_RUN_ID: '42' }),
    'https://github.com/a/b/actions/runs/42',
  );
});

test('缺任一项就返回空串，让调用方不放按钮', () => {
  assert.equal(runUrlFromEnv({ GITHUB_REPOSITORY: 'a/b', GITHUB_RUN_ID: '42' }), '');
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '42' }), '');
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'a/b' }), '');
  assert.equal(runUrlFromEnv({}), '');
});
