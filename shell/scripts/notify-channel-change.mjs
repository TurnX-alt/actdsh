// 比对两次通道快照，有语义变化就产出一张待发送的飞书卡片。
//
// 单独一个脚本而不是塞进探针：探针的退出码已经承担了「完整性」判定（error/warning 分级），
// 再叠一层「变化即非零」会让同一支脚本有两种互相矛盾的语义。变化是信息，不是失败。
//
// 用法: node shell/scripts/notify-channel-change.mjs <prev.json|--> <current.json> <card-out.json>
//   prev 传 - 表示「没有历史快照」（首次运行），此时只记一笔不发通知。
import { readFileSync, writeFileSync } from 'node:fs';

import { buildChannelChangeCard, diffSnapshots, runUrlFromEnv } from './lib/feishu-card.mjs';

const [prevArg, currentPath, cardOut] = process.argv.slice(2);
if (prevArg === undefined || currentPath === undefined || cardOut === undefined) {
  console.error('usage: node shell/scripts/notify-channel-change.mjs <prev.json|-> <current.json> <card-out.json>');
  process.exitCode = 2;
} else {
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const previous = prevArg === '-' ? null : JSON.parse(readFileSync(prevArg, 'utf8'));
  const changes = diffSnapshots(previous, current);
  const meaningful = changes.filter((c) => c.kind !== 'first-snapshot');
  if (meaningful.length === 0) {
    console.log(previous === null ? 'NO-PREV 首次快照，不发通知' : 'UNCHANGED 与上一次一致，不发通知');
  } else {
    const card = buildChannelChangeCard(changes, {
      repo: process.env.GITHUB_REPOSITORY ?? 'unknown',
      observedAt: current.observedAt,
      current,
      runUrl: runUrlFromEnv(),
      detail: meaningful.map((c) => c.target + ' · ' + c.kind + ' · ' + (c.from ?? 'null') + ' → ' + (c.to ?? 'null')).join('\n'),
    });
    if (card === null) {
      console.log('UNCHANGED 差异全被折叠，不发通知');
    } else {
      writeFileSync(cardOut, JSON.stringify(card));
      console.log('CHANGED ' + meaningful.length + ' 处变化，卡片已写入 ' + cardOut);
      for (const c of meaningful) console.log('  ' + c.target + ' ' + c.kind + ': ' + (c.from ?? 'null') + ' → ' + (c.to ?? 'null'));
    }
  }
}
