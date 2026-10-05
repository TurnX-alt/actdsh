// 把一次 workflow_run 事件整理成分诊要的 events.json。
//
// 为什么单独一个脚本：GitHub 表达式里拼不出「哪个 job 的哪个步骤红了 + 脚本自己写下的诊断行」，
// 而这段逻辑放进 YAML 就成了没人能测的 bash 泥。gh 的调用留在 shell 里（要 GH_TOKEN），
// 这里只做结构化。
//
// 用法: node shell/scripts/collect-triage-events.mjs <out.json>
//   DSH_TRIAGE_RUN_ID / DSH_TRIAGE_RUN_URL / DSH_TRIAGE_WORKFLOW / DSH_TRIAGE_CONCLUSION
//   DSH_TRIAGE_EVENT / DSH_TRIAGE_BRANCH      来自 workflow_run 上下文
//   DSH_TRIAGE_LOG_FILE                       已 dump 好的失败日志文本（可缺）
import { readFileSync, writeFileSync } from 'node:fs';

import { excerptFromLog } from './lib/feishu-card.mjs';

const out = process.argv[2];
const env = process.env;
if (out === undefined) {
  console.error('usage: node shell/scripts/collect-triage-events.mjs <out.json>');
  process.exitCode = 2;
} else {
  const workflow = env.DSH_TRIAGE_WORKFLOW ?? '(未知 workflow)';
  const conclusion = env.DSH_TRIAGE_CONCLUSION ?? '';
  const run = {
    runId: env.DSH_TRIAGE_RUN_ID ?? '',
    runUrl: env.DSH_TRIAGE_RUN_URL ?? '',
    workflow,
    event: env.DSH_TRIAGE_EVENT ?? '',
    branch: env.DSH_TRIAGE_BRANCH ?? '',
    conclusion,
  };
  let events;
  if (conclusion !== 'failure') {
    // 成功也要上报：它是「连续失败」的复位条件。
    events = [{ ...run, job: '', step: '', excerpt: '' }];
  } else {
    const jobs = JSON.parse(readFileSync(out + '.jobs', 'utf8'));
    const excerpt = excerptFromLog(env.DSH_TRIAGE_LOG_FILE
      ? readFileSync(env.DSH_TRIAGE_LOG_FILE, 'utf8') : '', { maxNotes: 4, maxChars: 240 });
    const failures = [];
    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        if (step.conclusion === 'failure') failures.push({ ...run, job: job.name, step: step.name, excerpt });
      }
    }
    // 没有任何步骤红（job 被取消、或整条 job 没跑）时也要留痕，否则这次失败在计数里是隐形的。
    events = failures.length > 0 ? failures : [{ ...run, job: '(没有步骤红)', step: '(未知步骤)', excerpt }];
  }
  writeFileSync(out, JSON.stringify(events, null, 1) + '\n');
  console.log('整理出 ' + events.length + ' 条事件（conclusion=' + (conclusion || '未知') + '）');
}
