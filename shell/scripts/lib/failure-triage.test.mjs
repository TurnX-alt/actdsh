// #41 之后的第四类需求：重复的红灯不能天天骚扰，也不能悄悄变噪声。
// 这里钉的是计数与动作的对应关系，以及「什么算一次新的失败」。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ESCALATE_AFTER,
  advanceTriageState,
  decideForFailure,
  describeFailure,
  markIssue,
  markNotified,
  signatureOf,
} from './failure-triage.mjs';

const W = '桌面版发布';
const fail = (runId, step = '版本线钉死（release 纯度）') => ({ workflow: W, job: '构建并验证 windows-x64', step, conclusion: 'failure', runId });
const ok = () => ({ workflow: W, job: '构建并验证 windows-x64', step: '版本线钉死（release 纯度）', conclusion: 'success', runId: 'r-ok' });
const SIG = signatureOf(fail('r1'));

test('签名定位到 workflow + job + step，不掺日志文本', () => {
  assert.equal(SIG, W + ' :: 构建并验证 windows-x64 :: 版本线钉死（release 纯度）');
  // 同一个位置、不同 run：仍是同一个签名（改文案不该被当成新故障）
  assert.equal(signatureOf(fail('r2')), SIG);
});

test('第一次失败要发；同一 run 重复上报不推进计数', () => {
  let state = advanceTriageState(null, [fail('r1')], { nowIso: '2026-10-05T00:00:00Z' });
  assert.equal(decideForFailure(state, SIG).action, 'notify');
  state = markNotified(state, SIG, 'r1', '2026-10-05T00:00:00Z');
  const again = advanceTriageState(state, [fail('r1')], { nowIso: '2026-10-05T00:10:00Z' });
  assert.equal(decideForFailure(again, SIG).action, 'silence', '同一 run 重放不该再动一次');
  assert.equal(again.signatures[SIG].streak, 1);
});

test('第 2 次静默，第 3 次开票——阈值两侧都要有边界', () => {
  let state = advanceTriageState(null, [fail('r1')], { nowIso: 't1' });
  state = advanceTriageState(state, [fail('r2')], { nowIso: 't2' });
  assert.equal(decideForFailure(state, SIG).action, 'silence', '第 2 次绝不再发卡——重复发卡就是噪声本身');
  assert.equal(state.signatures[SIG].streak, 2);
  state = advanceTriageState(state, [fail('r3')], { nowIso: 't3' });
  assert.equal(decideForFailure(state, SIG).action, 'escalate');
  assert.equal(DEFAULT_ESCALATE_AFTER, 3);
});

test('开过票之后不再重复开票，也不重复发卡', () => {
  let state = advanceTriageState(null, [fail('r1'), fail('r2'), fail('r3')], { nowIso: 't3' });
  state = markIssue(state, SIG, 99);
  assert.equal(decideForFailure(state, SIG).action, 'silence');
  state = advanceTriageState(state, [fail('r4')], { nowIso: 't4' });
  assert.equal(decideForFailure(state, SIG).action, 'silence', '已有 issue 的连续失败不该再开一张');
});

test('一次成功就把「连续」打断，下次失败重新按第一次算', () => {
  let state = advanceTriageState(null, [fail('r1'), fail('r2')], { nowIso: 't2' });
  assert.equal(state.signatures[SIG].streak, 2);
  state = advanceTriageState(state, [ok()], { nowIso: 't3' });
  assert.equal(state.signatures[SIG].streak, 0);
  state = advanceTriageState(state, [fail('r4')], { nowIso: 't4' });
  assert.equal(decideForFailure(state, SIG).action, 'notify', '复位后再红算新故障');
  assert.equal(state.signatures[SIG].streak, 1);
});

test('成功只复位自己那条线，别人的连续计数不受影响', () => {
  const other = { workflow: '上游版本线探针', job: '实时 registry 探针', step: '跑探针', conclusion: 'failure', runId: 'p1' };
  let state = advanceTriageState(null, [other, fail('r1')], { nowIso: 't1' });
  state = advanceTriageState(state, [ok()], { nowIso: 't2' });
  assert.equal(state.signatures[signatureOf(other)].streak, 1, '探针的连续失败还在累积');
  assert.equal(state.signatures[SIG].streak, 0);
});

test('首次与最近的时刻都留在状态里，票上才写得出「从哪天开始红的」', () => {
  let state = advanceTriageState(null, [fail('r1')], { nowIso: '2026-10-05T00:00:00Z' });
  state = advanceTriageState(state, [fail('r2')], { nowIso: '2026-10-05T09:00:00Z' });
  const text = describeFailure(state, SIG);
  assert.match(text, /连续第 2 次失败/);
  assert.match(text, /首次 2026-10-05T00:00:00Z/);
  assert.match(text, /最近 2026-10-05T09:00:00Z/);
});

test('不认识的结论既不计也不清，避免把取消当成失败', () => {
  const state = advanceTriageState(null, [{ ...fail('r1'), conclusion: 'cancelled' }], { nowIso: 't1' });
  assert.equal(state.signatures[SIG], undefined);
});
