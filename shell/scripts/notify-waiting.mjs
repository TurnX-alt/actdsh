// 判定「同一个 tag 等了多久」，并在越过阈值时产出那张黄色卡片。
//
// 用法: node shell/scripts/notify-waiting.mjs <prev.json|-> <current.json> <state-out.json> [card-out.json]
//   prev        上一轮入库的等待状态，- 表示没有（首次等待）
//   current     本轮探针写出的等待读数（DSH_WAITING_OUT 的产物）
//   state-out   本轮要存回 artifact 的状态，总是写
//   card-out    越过阈值时写卡片；没给又判该发，就直接报错且不落 notifiedAt——
//               否则「已经报过了」会被写进状态，而实际什么都没发出去，这条信号从此哑掉。
//
// 时钟用本轮读数的 checkedAt，不用 Date.now()：判定依据是可复现的时间戳，
// 而不是脚本自己的运行时刻。
import { readFileSync, writeFileSync } from 'node:fs';

import { buildWaitingCard, runUrlFromEnv } from './lib/feishu-card.mjs';
import {
  advanceWindowState,
  markNotified,
  shouldAlertWaiting,
  waitingHours,
} from './lib/publish-window.mjs';

const [prevArg, currentPath, stateOut, cardOut] = process.argv.slice(2);
if (prevArg === undefined || currentPath === undefined || stateOut === undefined) {
  console.error('usage: node shell/scripts/notify-waiting.mjs <prev.json|-> <current.json> <state-out.json> [card-out.json]');
  process.exitCode = 2;
} else {
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const previous = prevArg === '-' ? null : JSON.parse(readFileSync(prevArg, 'utf8'));
  const thresholdHours = Number(process.env.DSH_WAITING_ALERT_HOURS ?? 12);
  const staleAfterHours = Number(process.env.DSH_WAITING_STALE_HOURS ?? 72);
  const state = advanceWindowState(previous, current, { staleAfterHours });
  const hours = waitingHours(state, current.checkedAt);
  // 状态在判定之前就落盘：链条断一轮就等于 firstSeenAt 重置、计时从头开始，
  // 那条「等了多久」的信号会永久发不出去。发送失败可以下一轮重试，丢链条不行。
  const alert = shouldAlertWaiting(state, current.checkedAt, thresholdHours);
  if (alert && cardOut === undefined) {
    writeFileSync(stateOut, JSON.stringify(state, null, 1) + '\n');
    console.log('::error::判定该发等待卡片但未提供 card-out，notifiedAt 不落盘。');
    process.exitCode = 2;
  } else if (alert) {
    const repo = process.env.GITHUB_REPOSITORY ?? 'unknown';
    writeFileSync(cardOut, JSON.stringify(buildWaitingCard(state, {
      repo,
      hours,
      thresholdHours,
      runUrl: runUrlFromEnv(),
    })));
    writeFileSync(stateOut, JSON.stringify(markNotified(state, current.checkedAt), null, 1) + '\n');
    console.log('ALERT 已等 ' + hours.toFixed(1) + ' h ≥ ' + thresholdHours + ' h，缺失 '
      + state.missingCount + ' 个包，卡片已写入 ' + cardOut);
  } else {
    writeFileSync(stateOut, JSON.stringify(state, null, 1) + '\n');
    if (state.notifiedAt != null) {
      console.log('ALREADY-NOTIFIED 本窗口已在 ' + state.notifiedAt + ' 报过，不再骚扰');
    } else if (state.restartedBecause !== null) {
      // 首轮永远是 0 小时：没有可比的前一轮，窗口只能从这次观测开始计时。
      console.log('NEW ' + state.tag + '（' + state.restartedBecause + '）已等 0.0 h / 阈值 ' + thresholdHours + ' h');
    } else {
      console.log('WAITING 已等 ' + hours.toFixed(1) + ' h / 阈值 ' + thresholdHours + ' h，未越线');
    }
  }
}
