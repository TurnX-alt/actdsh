// 连续失败的分诊执行层：读上一轮的计数，对本轮跑完的 run 做「发 / 静默 / 开票」，写回状态。
//
// 判定全在 lib/failure-triage.mjs 的纯函数里，这里只做 IO；卡片仍交给 notify-feishu.mjs 发，
// 那个脚本带 webhook 脱敏兜底。
//
// 用法: node shell/scripts/notify-triage.mjs <prev-state.json|-> <events.json> <state-out.json> <cards-dir>
//   events.json  [{workflow, job, step, conclusion, runId, runUrl, excerpt}]
//   DSH_TRIAGE_ESCALATE_AFTER  连续第几次开票（默认 3）
//   DSH_TRIAGE_ISSUES=1        唯一允许建 issue 的开关，只在 alert-triage.yml 里设。
//                              默认不建：一次本地手滑就给用户仓库开出真票，这个失败形态
//                              比漏建严重得多（实测漏传变量时脚本确实去调了 gh issue create）。
//                              不设时只打印 WOULD-ESCALATE，状态里 issueNumber 保持 null，
//                              下一轮还会判 escalate——干跑不该把状态推绿。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFailureCard } from './lib/feishu-card.mjs';
import {
  advanceTriageState,
  decideForFailure,
  describeFailure,
  markIssue,
  markNotified,
  signatureOf,
} from './lib/failure-triage.mjs';

const [prevArg, eventsPath, stateOut, cardsDir] = process.argv.slice(2);
if (prevArg === undefined || eventsPath === undefined || stateOut === undefined || cardsDir === undefined) {
  console.error('usage: node shell/scripts/notify-triage.mjs <prev.json|-> <events.json> <state-out.json> <cards-dir>');
  process.exitCode = 2;
} else {
  const repo = process.env.GITHUB_REPOSITORY ?? 'unknown';
  const nowIso = new Date().toISOString();
  const escalateAfter = Number(process.env.DSH_TRIAGE_ESCALATE_AFTER ?? 3);
  const events = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const previous = prevArg === '-' ? null : JSON.parse(readFileSync(prevArg, 'utf8'));
  let state = advanceTriageState(previous, events, { nowIso });
  mkdirSync(cardsDir, { recursive: true });

  for (const event of events.filter((e) => e.conclusion === 'failure')) {
    const sig = signatureOf(event);
    const decision = decideForFailure(state, sig, { escalateAfter });
    const entry = state.signatures[sig] ?? {};
    const failure = {
      workflow: event.workflow, job: event.job, step: event.step,
      runId: event.runId ?? '(未知 run)', event: event.event ?? '(未知触发)',
      branch: event.branch ?? '(未知分支)', runUrl: event.runUrl ?? '',
      excerpt: (event.excerpt ?? '') + (event.excerpt ? '\n\n' : '')
        + describeFailure(state, sig),
    };

    if (decision.action === 'notify') {
      const file = join(cardsDir, 'notify-' + sanitize(sig) + '.json');
      writeFileSync(file, JSON.stringify(buildFailureCard(failure, { repo })));
      state = markNotified(state, sig, event.runId, nowIso);
      console.log('NOTIFY ' + sig + ' streak=' + decision.streak + ' 卡片 ' + file);
    } else if (decision.action === 'escalate') {
      const title = sig + ' 连续 ' + decision.streak + ' 次失败';
      const body = '由 alert-triage 自动开出。同一个位置连续红到第 ' + decision.streak
        + ' 次，说明这不是一次偶发，也不是重跑能解决的事。\n\n```\n' + (event.excerpt ?? '（日志里没有脚本写下的诊断行）')
        + '\n```\n\n' + describeFailure(state, sig)
        + '\n\n最近一次：' + (event.runUrl ? event.runUrl + '（' + String(event.runId) + '）' : 'run ' + String(event.runId))
        + '\n\n判定与去重规则见 shell/scripts/lib/failure-triage.mjs。';
      let number = null;
      if (process.env.DSH_TRIAGE_ISSUES !== '1') {
        console.log('WOULD-ESCALATE ' + sig + ' streak=' + decision.streak + '（未设 DSH_TRIAGE_ISSUES=1，不建 issue）');
      } else {
        const out = execFileSync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body],
          { encoding: 'utf8' });
        number = Number(String(out).match(/\/(\d+)\s*$/)?.[1] ?? NaN);
        if (!Number.isInteger(number)) throw new Error('建票后没解析出 issue 编号，输出: ' + out);
        state = markIssue(state, sig, number);
        const cardFile = join(cardsDir, 'escalate-' + sanitize(sig) + '.json');
        writeFileSync(cardFile, JSON.stringify(buildFailureCard(
          { ...failure, excerpt: failure.excerpt + '\n\n已自动开票 #' + number + '，后续重复失败不再骚扰。' },
          { repo },
        )));
        console.log('ESCALATE ' + sig + ' streak=' + decision.streak + ' issue=#' + number + ' 卡片 ' + cardFile);
      }
    } else {
      console.log('SILENCE ' + sig + ' streak=' + decision.streak + '（' + (decision.reason ?? '') + '）');
    }
  }

  writeFileSync(stateOut, JSON.stringify(state, null, 1) + '\n');
}

// 只留 ASCII 会把中文步骤名剥成同一个空壳（两个不同签名撞成同一个文件名、互相覆盖），
// 所以补一段签名哈希：文件名可读且唯一。
function sanitize(text) {
  const readable = String(text).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48);
  const tag = createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
  return readable + '-' + tag;
}
