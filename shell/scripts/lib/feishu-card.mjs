// 飞书交互卡片（Card JSON 2.0，自定义机器人 webhook 形态）的构造与通道快照差异。
// 纯函数、无 IO：发送在 notify-feishu.mjs，判定在探针里。
//
// 卡片类型只有三种，对应 #29 定下的三类信号：
//   failure        —— 探针或发布真的红了
//   channel-change —— 探针绿着，但它观测的东西变了（2026-10-02 mac-x64 从 404 变在架就是这类）
//   waiting        —— 一直绿着一事无成（上游没发齐，poll 天天空转）
//
// 自定义机器人是单向的：卡片只允许 open_url 导航，绝不放 callback、form、输入控件。

export const SCHEMA_VERSION = '2.0';

const THEME_BY_LEVEL = { failure: 'red', channel: 'orange', waiting: 'yellow' };
const TAG_BY_LEVEL = { failure: '失败', channel: '语义变化', waiting: '等待中' };

function plain(content) {
  return { tag: 'plain_text', content: String(content) };
}

function metric(label, value) {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_spacing: '4px',
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: label, text_color: 'grey', text_size: 'notation' } },
      { tag: 'div', text: { tag: 'plain_text', content: String(value), text_size: 'normal' } },
    ],
  };
}

function openUrlBehavior(url) {
  return { type: 'open_url', default_url: url, pc_url: url, ios_url: url, android_url: url };
}

function linkButton(text, url, type) {
  return {
    tag: 'button',
    text: plain(text),
    type,
    size: 'medium',
    width: 'fill',
    behaviors: [openUrlBehavior(url)],
  };
}

/**
 * 构造一张 webhook 信封卡片。
 * @param spec - {{ level, title, subtitle, summary, metrics: [[label, value]], links: [[text, url]], detail? }}
 */
export function buildAlertCard(spec) {
  const level = spec.level ?? 'channel';
  if (THEME_BY_LEVEL[level] === undefined) throw new Error('未知告警级别: ' + level);
  const elements = [{ tag: 'markdown', content: spec.summary, text_align: 'left', text_size: 'normal' }];
  if (Array.isArray(spec.metrics) && spec.metrics.length > 0) {
    elements.push({
      tag: 'column_set',
      flex_mode: spec.metrics.length > 2 ? 'bisect' : 'stretch',
      horizontal_spacing: '8px',
      columns: spec.metrics.slice(0, 4).map(([label, value]) => metric(label, value)),
    });
  }
  if (typeof spec.detail === 'string' && spec.detail !== '') {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: plain('细节') },
      border: { color: 'grey', thickness: '1px' },
      elements: [{ tag: 'markdown', content: spec.detail, text_size: 'notation' }],
    });
  }
  for (const [text, url] of spec.links ?? []) elements.push(linkButton(text, url, 'primary_filled'));
  return {
    msg_type: 'interactive',
    card: {
      schema: SCHEMA_VERSION,
      config: { update_multi: true, width_mode: 'compact', summary: { content: spec.title } },
      header: {
        template: THEME_BY_LEVEL[level],
        title: plain(spec.title),
        ...(spec.subtitle === undefined ? {} : { subtitle: plain(spec.subtitle) }),
        padding: '12px',
      },
      body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements },
    },
  };
}

// ---- 通道快照差异 ----

/**
 * 归一化探针读数成可比快照。只留会「变」的字段；URL 里的版本串与时间戳才是语义。
 * @param readings - [{ target, present, version?, declaredSize?, releaseDate? }]
 */
export function snapshotOf(readings, observedAt) {
  const targets = {};
  for (const r of readings) targets[r.target] = r.present
    ? { version: r.version ?? null, declaredSize: r.declaredSize ?? null, releaseDate: r.releaseDate ?? null }
    : null;
  return { schemaVersion: 1, observedAt, targets };
}

/**
 * 两份快照的语义差异。缺席→在架、在架→缺席、版本变、大小变、发布时间变都算变化。
 * @returns {Array<{target, kind, from, to}>} 空数组表示「什么都没变」，此时不该发通知。
 */
export function diffSnapshots(previous, current) {
  if (previous == null || typeof previous !== 'object') {
    return [{ target: '*', kind: 'first-snapshot', from: null, to: current.observedAt ?? null }];
  }
  const changes = [];
  const prevTargets = previous.targets ?? {};
  const nextTargets = current.targets ?? {};
  for (const target of new Set([...Object.keys(prevTargets), ...Object.keys(nextTargets)])) {
    const a = prevTargets[target];
    const b = nextTargets[target];
    if ((a == null) !== (b == null)) {
      changes.push({ target, kind: a == null ? 'appeared' : 'disappeared', from: a?.version ?? null, to: b?.version ?? null });
      continue;
    }
    if (a == null) continue;
    for (const field of ['version', 'declaredSize', 'releaseDate']) {
      if (a[field] !== b[field]) changes.push({ target, kind: field, from: a[field] ?? null, to: b[field] ?? null });
    }
  }
  return changes;
}

/** 把差异列表渲染成卡片。first-snapshot 是初始化，不发通知（否则每次重部署都骚扰一次）。 */
export function buildChannelChangeCard(changes, context) {
  const meaningful = changes.filter((c) => c.kind !== 'first-snapshot');
  if (meaningful.length === 0) return null;
  const lines = meaningful.map((c) => '- **' + c.target + '** ' + labelOfChange(c));
  return buildAlertCard({
    level: 'channel',
    title: '官方桌面版通道变了',
    subtitle: context.repo + ' · ' + (context.observedAt ?? ''),
    summary: lines.join('\n')
      + '\n\n探针是绿的，所以这条只能靠差异发现——它观测的东西变了，而绿灯不会告诉你。',
    metrics: [['变化条数', meaningful.length], ['通道', Object.keys(context.current?.targets ?? {}).length]],
    links: typeof context.runUrl === 'string' ? [['查看 run', context.runUrl]] : [],
    detail: context.detail,
  });
}

function labelOfChange(change) {
  if (change.kind === 'appeared') return '从缺席变为在架（' + change.to + '）';
  if (change.kind === 'disappeared') return '通道消失了（曾为 ' + change.from + '）';
  if (change.kind === 'version') return '版本 ' + change.from + ' → ' + change.to;
  if (change.kind === 'declaredSize') return '声明大小 ' + change.from + ' → ' + change.to;
  if (change.kind === 'releaseDate') return '发布时间 ' + change.from + ' → ' + change.to;
  return change.kind + ' ' + change.from + ' → ' + change.to;
}

/** 失败卡片。runUrl 缺失时不放按钮——宁可不方便，也不放一个空链接。 */
export function buildFailureCard(failure, context) {
  return buildAlertCard({
    level: 'failure',
    title: failure.workflow + ' 失败',
    subtitle: context.repo,
    summary: '**' + failure.job + '** 的 `' + failure.step + '` 步骤红了。\n\n' + failure.excerpt,
    metrics: [['run', failure.runId], ['触发', failure.event], ['分支', failure.branch]],
    links: typeof failure.runUrl === 'string' && failure.runUrl !== ''
      ? [['打开 run 看日志', failure.runUrl]]
      : [],
  });
}

/**
 * 从日志文本里只取脚本自己写下的诊断行（`::error::` / `::warning::` annotation）。
 *
 * 不做尾部 dump：日志尾部通常是 npm/PowerShell 的噪声，而原始日志行里可能有 Markdown
 * 控制字符，卡片正文不是日志查看器。脚本要说什么，由脚本自己用 annotation 说。
 * 没有 annotation 时返回固定文案并指向 run，而不是猜一个失败原因。
 */
export function excerptFromLog(text, options = {}) {
  const { maxNotes = 6, maxChars = 200 } = options;
  const fallback = options.fallback ?? '日志里没有脚本自己写下的诊断行，请打开 run 查看完整日志。';
  const notes = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const note = annotationOf(raw.trim());
    if (note !== null) notes.push(note);
  }
  if (notes.length === 0) return fallback;
  const picked = notes.slice(0, maxNotes).map((n) => {
    const where = n.file === undefined ? '' : n.file + (n.line === undefined ? '' : ':' + n.line) + ' · ';
    const body = n.message.length > maxChars ? n.message.slice(0, maxChars - 1) + '…' : n.message;
    return (n.level === 'error' ? '❌ ' : '⚠️ ') + where + body;
  });
  const more = notes.length > maxNotes ? '\n（另有 ' + (notes.length - maxNotes) + ' 条诊断行，见 run）' : '';
  return picked.join('\n') + more;
}

const ANNOTATION_LEVELS = new Set(['error', 'warning']);

// 形态：`::name key=value,key=value::message`（GitHub annotation 语法）。
// 第二段用 indexOf 而不是正则回溯：params 里不会出现 `::`，正则反而更难读。
function annotationOf(line) {
  if (!line.startsWith('::')) return null;
  const end = line.indexOf('::', 2);
  if (end === -1) return null;
  const [level, ...kv] = line.slice(2, end).trim().split(/\s+/);
  if (!ANNOTATION_LEVELS.has(level)) return null;
  const message = line.slice(end + 2).trim();
  if (message === '') return null;
  const params = Object.fromEntries(
    kv.join(' ').split(',').map((pair) => pair.split('=').map((s) => s.trim())).filter((p) => p.length === 2 && p[1] !== ''),
  );
  return { level, message, file: params.file, line: params.line };
}

/**
 * 兜底脱敏：卡片里绝不允许出现 webhook 或 token。发送脚本与探针都不该把 URL 塞进正文。
 * 命中即抛错——把密钥留在日志里比发不出通知糟得多。
 */
export function assertNoSecrets(card, secrets = []) {
  const text = JSON.stringify(card);
  for (const secret of secrets.filter((s) => typeof s === 'string' && s.length > 8)) {
    if (text.includes(secret)) throw new Error('卡片内容含疑似密钥，拒绝发送');
  }
  return card;
}

export function tagForLevel(level) {
  return TAG_BY_LEVEL[level] ?? level;
}
