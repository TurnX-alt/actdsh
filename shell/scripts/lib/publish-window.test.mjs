// #41：持续等待的跨 run 计数。这里钉住的是三件事——
// 计时用时间戳而不是轮次（cron 实测晚 4–9 小时）、同一窗口只报一次、窗口重开的条件。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildWaitingCard } from './feishu-card.mjs';
import {
  advanceWindowState,
  DEFAULT_ALERT_AFTER_HOURS,
  markNotified,
  shouldAlertWaiting,
  waitingHours,
} from './publish-window.mjs';

const runFile = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../notify-waiting.mjs', import.meta.url));

const HOUR = '1970-01-01T00:00:00.000Z';
const at = (hours) => new Date(hours * 3600 * 1000).toISOString();
const reading = (tag, hours, missing = ['@deepseek-ai/dsh-plugin-pstack']) => ({
  schemaVersion: 1,
  tag,
  missingCount: missing.length,
  missing,
  checkedAt: at(hours),
});

test('首次等待：窗口从今天算起，且没报过', () => {
  const s = advanceWindowState(null, reading('0.2.0-rc.3', 0));
  assert.equal(s.firstSeenAt, HOUR);
  assert.equal(s.notifiedAt, null);
  assert.equal(s.restartedBecause, 'no-prev');
});

test('同一 tag 的下一轮继承 firstSeenAt，等待时长才累得起来', () => {
  const first = advanceWindowState(null, reading('0.2.0-rc.3', 0));
  const second = advanceWindowState(first, reading('0.2.0-rc.3', 5));
  assert.equal(second.firstSeenAt, first.firstSeenAt);
  assert.equal(second.lastSeenAt, at(5));
  assert.equal(waitingHours(second, at(5)), 5);
});

test('cron 晚 9 小时也照样累加——判定不数轮次，只看时间戳', () => {
  const first = advanceWindowState(null, reading('0.2.0-rc.3', 0));
  // 一天后才跑第二轮（日粒度 cron + 4–9 小时延迟的实测形态）
  const next = advanceWindowState(first, reading('0.2.0-rc.3', 33));
  assert.equal(next.firstSeenAt, first.firstSeenAt);
  assert.ok(shouldAlertWaiting(next, at(33)));
});

test('换 tag 就是新窗口，旧窗口的计时不能带过去', () => {
  const old = advanceWindowState(null, reading('0.2.0-rc.2', 0));
  const alerted = markNotified(old, at(13));
  const fresh = advanceWindowState(alerted, reading('0.2.0-rc.3', 100));
  assert.equal(fresh.tag, '0.2.0-rc.3');
  assert.equal(fresh.firstSeenAt, at(100));
  assert.equal(fresh.notifiedAt, null);
  assert.equal(fresh.restartedBecause, 'tag-changed');
});

test('同 tag 但链条老于 72 小时：窗口早已关上，重开而不是继续累加', () => {
  const old = advanceWindowState(null, reading('0.2.0-rc.2', 0));
  const reopened = advanceWindowState(old, reading('0.2.0-rc.2', 80), { staleAfterHours: 72 });
  assert.equal(reopened.restartedBecause, 'stale');
  assert.equal(reopened.firstSeenAt, at(80));
});

test('阈值边界：11.99 小时不发，12 小时发，报过之后永不重复', () => {
  const s = advanceWindowState(null, reading('0.2.0-rc.3', 0));
  assert.equal(shouldAlertWaiting(s, at(11.99), DEFAULT_ALERT_AFTER_HOURS), false);
  assert.equal(shouldAlertWaiting(s, at(12), DEFAULT_ALERT_AFTER_HOURS), true);
  assert.equal(shouldAlertWaiting(markNotified(s, at(12)), at(90), DEFAULT_ALERT_AFTER_HOURS), false);
});

test('checkedAt 不可解析时抛错，不当成 0 小时', () => {
  assert.throws(() => advanceWindowState(null, { tag: 'x', missingCount: 1, checkedAt: 'not-a-date' }), /checkedAt/);
  assert.ok(Number.isNaN(waitingHours({ firstSeenAt: 'bad' }, HOUR)));
});

test('等待卡片是黄的、只带 open_url、并把缺失包列进折叠区', () => {
  const state = advanceWindowState(null, reading('0.2.0-rc.3', 0, ['a', 'b', 'c']));
  const card = buildWaitingCard(state, { repo: 'x/y', hours: 13.5, thresholdHours: 12, runUrl: 'https://github.com/x/y/actions/runs/1' });
  assert.equal(card.card.header.template, 'yellow');
  const text = JSON.stringify(card);
  assert.equal(text.includes('callback'), false);
  assert.equal(text.includes('"form"'), false);
  assert.match(card.card.header.title.content, /还没发齐 0\.2\.0-rc\.3/);
  const panel = card.card.body.elements.find((e) => e.tag === 'collapsible_panel');
  assert.equal(panel.elements[0].content.includes('- a'), true);
});

// CLI 这一层要证明的是「状态真的会传下去」：每一轮读上一轮写出的文件。
// 首轮永远是 0 小时——没有可比的前一轮，所以计时必须靠链条，而不是靠单轮的观测值。
test('CLI：首轮 NEW(0h) → 越阈值 ALERT → 再进来 ALREADY-NOTIFIED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actdsh-waiting-'));
  try {
    const cur = join(dir, 'current.json');
    const s1 = join(dir, 'state1.json');
    const s2 = join(dir, 'state2.json');
    const s3 = join(dir, 'state3.json');
    const card2 = join(dir, 'card2.json');
    const card3 = join(dir, 'card3.json');

    writeJson(cur, reading('0.2.0-rc.3', 0));
    const first = await cli(['-', cur, s1, join(dir, 'card1.json')]);
    assert.match(first.stdout, /NEW 0\.2\.0-rc\.3（no-prev）已等 0\.0 h/);
    assert.equal(existsSafe(join(dir, 'card1.json')), false);

    writeJson(cur, reading('0.2.0-rc.3', 5));
    const s1b = join(dir, 'state1b.json');
    const mid = await cli([s1, cur, s1b, join(dir, 'cardMid.json')]);
    assert.match(mid.stdout, /WAITING 已等 5\.0 h/);
    assert.equal(existsSafe(join(dir, 'cardMid.json')), false);
    assert.equal(JSON.parse(readFileSync(s1b, 'utf8')).firstSeenAt, HOUR);

    writeJson(cur, reading('0.2.0-rc.3', 13));
    const second = await cli([s1b, cur, s2, card2]);
    assert.match(second.stdout, /ALERT 已等 13\.0 h/);
    assert.equal(JSON.parse(readFileSync(s2, 'utf8')).notifiedAt, at(13));
    assert.match(JSON.parse(readFileSync(card2, 'utf8')).card.header.title.content, /还没发齐 0\.2\.0-rc\.3/);

    writeJson(cur, reading('0.2.0-rc.3', 20));
    const third = await cli([s2, cur, s3, card3]);
    assert.match(third.stdout, /ALREADY-NOTIFIED/);
    assert.equal(existsSafe(card3), false);
    assert.equal(JSON.parse(readFileSync(s3, 'utf8')).firstSeenAt, HOUR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：判该发却没给 card-out 时不落 notifiedAt，但链条不能断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actdsh-waiting-'));
  try {
    const cur = join(dir, 'current.json');
    const s1 = join(dir, 'state1.json');
    const s2 = join(dir, 'state2.json');
    writeJson(cur, reading('0.2.0-rc.3', 0));
    await cli(['-', cur, s1]);
    writeJson(cur, reading('0.2.0-rc.3', 30));
    const r = await cli([s1, cur, s2]);
    assert.match(r.stdout, /::error::/);
    assert.equal(r.code, 2);
    const state = JSON.parse(readFileSync(s2, 'utf8'));
    assert.equal(state.notifiedAt, null);
    assert.equal(state.firstSeenAt, HOUR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 1));
}

async function cli(args) {
  try {
    const { stdout } = await runFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, GITHUB_REPOSITORY: 'x/y', GITHUB_RUN_ID: '1', GITHUB_SERVER_URL: 'https://github.com' },
    });
    return { stdout, code: 0 };
  } catch (error) {
    return { stdout: String(error.stdout ?? ''), code: error.code };
  }
}

function existsSafe(path) {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
