// 连续失败的判定：给「同一条线又红了」这件事加上记忆，让第一次值得看、第三次变成一张票。
// 纯函数、无 IO——事件由调用方（alert-triage.yml）从 gh api 取来喂进。
//
// 为什么要有这个：告警一旦重复就变成噪声，而噪声的真正代价不是吵，是让人学会不看——
// 那之后真出事也没人接。所以规则是「第一次发、重复静默、连续第三次开票并降级」。
//
// 计数的复位条件是「同一条 workflow 成功了一次」，不是时间过期：cron 实测晚 4–9 小时，
// 按时间窗会把一次真实的连续失败拆成两次「第一次」。

export const SCHEMA_VERSION = 1;
export const DEFAULT_ESCALATE_AFTER = 3;

/** 失败签名：定位到 workflow + job + step。不掺入日志文本，否则一次改文案就被当成新故障。 */
export function signatureOf(failure) {
  return [failure.workflow ?? '(未知 workflow)', failure.job ?? '(未知 job)', failure.step ?? '(未知步骤)'].join(' :: ');
}

function blankEntry(nowIso) {
  return {
    streak: 0,
    firstFailedAt: null,
    lastFailedAt: null,
    lastNotifiedAt: null,
    notifiedStreak: 0,
    issueNumber: null,
    lastRunId: null,
  };
}

function entries(state) {
  return (state && typeof state === 'object' && state.signatures && typeof state.signatures === 'object')
    ? state.signatures : {};
}

/**
 * 记一次「某 workflow 跑完了」。conclusion 为 success 时清掉该 workflow 名下所有签名的连续计数——
 * 一次绿就把「连续」打断，这是「连续失败」这个词的本义。
 *
 * @param prev   上一轮入库的状态，可为 null（首次）
 * @param events 本轮的 run 结果：[{workflow, job, step, conclusion, runId}]
 */
export function advanceTriageState(prev, events, options = {}) {
  const { nowIso } = options;
  const signatures = {};
  for (const [key, value] of Object.entries(entries(prev))) signatures[key] = { ...blankEntry(nowIso), ...value };

  for (const event of events ?? []) {
    const workflow = event.workflow ?? '(未知 workflow)';
    if (event.conclusion === 'success') {
      for (const key of Object.keys(signatures)) {
        if (key.startsWith(workflow + ' :: ')) signatures[key] = { ...signatures[key], streak: 0, notifiedStreak: 0 };
      }
      continue;
    }
    if (event.conclusion !== 'failure') continue;
    const key = signatureOf(event);
    const entry = { ...blankEntry(nowIso), ...(signatures[key] ?? {}) };
    // 同一个 run 重复上报（重跑同一 run 不会发生，但 triage 可能被手动重放）不该把计数推高。
    if (entry.lastRunId !== (event.runId ?? null)) {
      entry.streak = (entry.streak ?? 0) + 1;
      entry.firstFailedAt = entry.streak === 1 ? (event.observedAt ?? nowIso ?? null) : entry.firstFailedAt;
      entry.lastFailedAt = event.observedAt ?? nowIso ?? null;
      entry.lastRunId = event.runId ?? null;
    }
    signatures[key] = entry;
  }
  return { schemaVersion: SCHEMA_VERSION, observedAt: nowIso ?? null, signatures };
}

/**
 * 这一笔失败该不该发、该不该开票。
 * 只有「新故障的第一次」发卡；第 2 次起静默，攒到第 3 次开票（并随票发一张交代性的卡片）。
 * 中间格重复发卡正是我们要消灭的东西：它会教会人不看告警。
 */
export function decideForFailure(state, signature, options = {}) {
  const { escalateAfter = DEFAULT_ESCALATE_AFTER } = options;
  const entry = entries(state)[signature];
  if (entry === undefined) return { action: 'silence', streak: 0, reason: '状态里没有这个签名' };
  if (entry.streak === 0) return { action: 'silence', streak: 0, reason: '本轮没有推进计数（同一 run 重复上报或已复位）' };
  if (entry.streak >= escalateAfter && entry.issueNumber == null) return { action: 'escalate', streak: entry.streak };
  if (entry.streak === 1 && entry.notifiedStreak !== 1) return { action: 'notify', streak: entry.streak };
  return { action: 'silence', streak: entry.streak, reason: entry.streak >= escalateAfter
    ? '已有 issue，不再重复动作' : '重复失败，等第 ' + escalateAfter + ' 次开票' };
}

/** 发过之后落到状态里；开票同理——动作与状态必须一起走，否则下一轮会再动一次。 */
export function markNotified(state, signature, runId, nowIso) {
  const signatures = { ...entries(state) };
  signatures[signature] = { ...signatures[signature], lastNotifiedAt: nowIso ?? null, notifiedStreak: signatures[signature]?.streak ?? null };
  return { ...state, signatures };
}

export function markIssue(state, signature, issueNumber) {
  const signatures = { ...entries(state) };
  signatures[signature] = { ...signatures[signature], issueNumber };
  return { ...state, signatures };
}

/** 给 issue 正文用的小结：同一签名已经连续失败时，人和票都需要知道从什么时候开始算的。 */
export function describeFailure(state, signature) {
  const entry = entries(state)[signature] ?? {};
  return '连续第 ' + (entry.streak ?? 0) + ' 次失败；首次 ' + (entry.firstFailedAt ?? '未知')
    + '，最近 ' + (entry.lastFailedAt ?? '未知') + '，最近 run ' + (entry.lastRunId ?? '未知');
}
