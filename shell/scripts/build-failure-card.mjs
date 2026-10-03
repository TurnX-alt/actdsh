// 把一次失败的 run 组装成飞书卡片，供 workflow 的 `if: failure()` 步骤调用。
//
// 上下文全部来自 Actions 自带的环境变量，日志只读探针自己写进 RUNNER_TEMP 的那份：
// 不叫 gh run view --log-failed，那样要把整段日志过一遍网络，还会把不相关的行带进卡片。
//
// 用法: node shell/scripts/build-failure-card.mjs <card-out.json>
//   DSH_FAIL_JOB / DSH_FAIL_STEP / DSH_FAIL_LOG  由 workflow 显式给出
import { readFileSync, writeFileSync } from 'node:fs';

import { buildFailureCard, excerptFromLog, runUrlFromEnv } from './lib/feishu-card.mjs';

const out = process.argv[2];
if (out === undefined) {
  console.error('usage: node shell/scripts/build-failure-card.mjs <card-out.json>');
  process.exitCode = 2;
} else {
  const env = process.env;
  const runId = env.GITHUB_RUN_ID ?? '';
  const repo = env.GITHUB_REPOSITORY ?? 'unknown';
  let log = '';
  if (env.DSH_FAIL_LOG !== undefined && env.DSH_FAIL_LOG !== '') {
    try {
      log = readFileSync(env.DSH_FAIL_LOG, 'utf8');
    } catch {
      log = ''; // 日志文件不存在＝失败发生在探针之前，走 fallback 文案。
    }
  }
  const card = buildFailureCard({
    workflow: env.GITHUB_WORKFLOW ?? '(未知 workflow)',
    job: env.DSH_FAIL_JOB ?? env.GITHUB_JOB ?? '(未知 job)',
    step: env.DSH_FAIL_STEP ?? '(未知步骤)',
    runId,
    event: env.GITHUB_EVENT_NAME ?? '(未知)',
    branch: env.GITHUB_REF_NAME ?? '(未知)',
    runUrl: runUrlFromEnv(),
    excerpt: excerptFromLog(log),
  }, { repo });
  writeFileSync(out, JSON.stringify(card));
  console.log('失败卡片已写入 ' + out);
}
