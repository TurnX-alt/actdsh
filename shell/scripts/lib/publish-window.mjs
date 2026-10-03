// 上游 npm 家族发布窗口的跨 run 状态。纯函数、无 IO。
//
// 为什么需要它：poll 在窗口内以退出码 3 空转（#32 的决议——窗口会自己关上，不该炸一次构建）。
// 但没有东西区分「正常等 20 分钟」和「等了三天还在等」。实测窗口是 20 分到 97 分
// （rc.1 根包 12:34:03 → settings-account 12:54:22；rc.2 的 settings-account 在根包后 80 分才出现），
// 超过 12 小时就意味着要么上游没发齐，要么我们的闭包判定和真实 registry 已经不一致——
// 两种都值得人看一眼。
//
// 计时一律用 UTC 时间戳，不用「第几轮」：GitHub 的 cron 实测晚 4–9 小时（skland、actdsh 都有记录），
// 按轮次计数会把阈值变成随机数。

const HOUR_MS = 3600 * 1000;

/** 默认 72 小时：窗口早于这个长度关上过，就不再算「等一轮」。 */
export const DEFAULT_STALE_AFTER_HOURS = 72;

/** 阈值 12 小时：远大于实测的 97 分钟，又短到不至于让人第二天才发现。 */
export const DEFAULT_ALERT_AFTER_HOURS = 12;

export function parseTime(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * 推进一轮等待状态。current 是本轮探针写出的等待读数。
 *
 * 重开窗口的两种情况：tag 变了（本就是另一个窗口），或同一 tag 但 firstSeenAt 老于
 * staleAfterHours——只有仍在等待的轮次会写状态，链条这么长说明中间窗口早已关上，
 * 那次等待属于另一个问题（上游根本不发齐），重新计时而不是继续累加。
 */
export function advanceWindowState(prev, current, options = {}) {
  const { staleAfterHours = DEFAULT_STALE_AFTER_HOURS } = options;
  const now = parseTime(current.checkedAt);
  if (!Number.isFinite(now)) throw new Error('等待读数缺少可用的 checkedAt: ' + current.checkedAt);
  const prevFirstSeen = prev != null && typeof prev === 'object' ? parseTime(prev.firstSeenAt) : Number.NaN;
  const reason = prev == null || typeof prev !== 'object'
    ? 'no-prev'
    : prev.tag !== current.tag ? 'tag-changed'
      : !Number.isFinite(prevFirstSeen) ? 'no-first-seen'
        : now - prevFirstSeen > staleAfterHours * HOUR_MS ? 'stale' : null;
  return {
    schemaVersion: 1,
    tag: current.tag,
    firstSeenAt: reason === null ? prev.firstSeenAt : current.checkedAt,
    lastSeenAt: current.checkedAt,
    // notifiedAt 随窗口一起继承——去重就靠它，没有它每轮都会再骚扰一次。
    notifiedAt: reason === null ? prev.notifiedAt ?? null : null,
    missingCount: current.missingCount,
    missing: Array.isArray(current.missing) ? current.missing : [],
    restartedBecause: reason,
  };
}

export function waitingHours(state, nowIso) {
  const now = parseTime(nowIso);
  const first = parseTime(state?.firstSeenAt);
  if (!Number.isFinite(now) || !Number.isFinite(first)) return Number.NaN;
  return (now - first) / HOUR_MS;
}

/**
 * 该不该发这张卡片。已报过的窗口永不重复（#41 的「只在超时那一刻发一次」）。
 * 时间基准用调用方传入的 nowIso，脚本自己不在判定里读时钟——那样才可测。
 */
export function shouldAlertWaiting(state, nowIso, thresholdHours = DEFAULT_ALERT_AFTER_HOURS) {
  if (state == null || state.notifiedAt != null) return false;
  const hours = waitingHours(state, nowIso);
  return Number.isFinite(hours) && hours >= thresholdHours;
}

export function markNotified(state, nowIso) {
  return { ...state, notifiedAt: nowIso };
}
