// 把一张已构造好的飞书卡片 POST 到自定义机器人 webhook。
//
// webhook 地址只从环境变量读，且**永不回显**：它本身就是一次写入凭据，泄露等于任何人可向该群发消息。
// 卡片正文在进入网络前过一次脱敏，避免「把地址打进通知里」这种自伤。
//
// 用法: node shell/scripts/notify-feishu.mjs <card.json>
//   FEISHU_WEBHOOK_URL   必填
//   FEISHU_ALERT_DISABLE 设为 1 时只打印不发（用于本地试跑与 CI 干跑）
import { readFileSync } from 'node:fs';

import { assertNoSecrets } from './lib/feishu-card.mjs';

const WEBHOOK = process.env.FEISHU_WEBHOOK_URL ?? '';
const cardPath = process.argv[2];

if (cardPath === undefined) {
  console.error('usage: node shell/scripts/notify-feishu.mjs <card.json>');
  process.exitCode = 2;
} else if (WEBHOOK === '') {
  console.log('::error::FEISHU_WEBHOOK_URL 未设置，跳过发送');
  process.exitCode = 1;
} else {
  try {
    const card = JSON.parse(readFileSync(cardPath, 'utf8'));
    assertNoSecrets(card, [WEBHOOK]);
    if (process.env.FEISHU_ALERT_DISABLE === '1') {
      console.log('FEISHU_ALERT_DISABLE=1，未发送。卡片摘要：' + card.card.config.summary.content);
    } else {
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      // 飞书成功返回 {"StatusCode":0,"code":0,"data":{},"msg":"success"}；
      // 只有 200 不算送达，必须读 code——很多字段错误仍回 200。
      let code = Number.NaN;
      try {
        const parsed = JSON.parse(text);
        code = parsed.code ?? parsed.StatusCode;
      } catch {
        code = Number.NaN;
      }
      if (!res.ok || code !== 0) {
        console.log('::error::飞书返回 HTTP ' + res.status + ' code=' + (Number.isNaN(code) ? '非JSON' : code)
          + ' msg=' + (safeMsg(text)));
        process.exitCode = 1;
      } else {
        console.log('已送达飞书：' + card.card.config.summary.content);
      }
    }
  } catch (error) {
    console.log('::error::发送失败：' + error.message);
    process.exitCode = 1;
  }
}

// 响应体里可能回显我们发过去的内容，因此只取 msg 字段，不整段落日志。
function safeMsg(text) {
  try {
    return String(JSON.parse(text).msg ?? '').slice(0, 200);
  } catch {
    return '(响应非 JSON，已省略)';
  }
}
