// 官方桌面版产物复核：把通道声明的 sha512/size 与真正下载到的字节对齐，作为发布闸门。
//
// 为什么值得花这几分钟：官方 Release 在 GitHub 上没有 assets，桌面包只走
// download.deepseek.com，没人从第三方核对过「通道说的那个哈希，CDN 上确实是那些字节」。
// actdsh 定位为官方桌面版的独立校验（地图 #17 的 D3），这一步就是那条主张的实证。
//
// 失败即阻断发布（fail closed）：宁可因为一次网络抖动重跑，也不要放过「通道与字节不一致」。
// 网络重试只有一次机会（共 2 趟），每趟从头流式重算。
//
// 用法: node shell/scripts/verify-official-artifact.mjs [target]   默认 win-x64
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import {
  artifactUrlFor,
  checkArtifactDigest,
  checkChannelShape,
  feedUrlFor,
  parseChannel,
} from './lib/official-desktop-feed.mjs';

const ORIGIN = (process.env.DSH_OFFICIAL_FEED_ORIGIN ?? 'https://download.deepseek.com').replace(/\/+$/, '');
const ATTEMPTS = 2;
const FEED_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const PROGRESS_EVERY = 64 * 1024 * 1024;

const target = (process.argv[2] ?? 'win-x64').trim();

async function fetchChannel() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(feedUrlFor(target, ORIGIN), {
        headers: { accept: 'text/yaml, text/plain, */*' },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (res.status === 404) throw new Error('通道不存在（404）');
      if (!res.ok) throw new Error('通道 HTTP ' + res.status);
      return parseChannel(await res.text());
    } catch (error) {
      if (error.message?.includes('通道不存在')) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('通道读取失败');
}

async function digestArtifact(url, expectedSize) {
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error('产物 HTTP ' + res.status);
      const hash = createHash('sha512');
      let size = 0;
      let nextProgress = PROGRESS_EVERY;
      for await (const chunk of res.body) {
        hash.update(chunk);
        size += chunk.length;
        if (size >= nextProgress) {
          console.log('  已取回 ' + Math.round(size / 1048576) + ' MB'
            + (Number.isSafeInteger(expectedSize) ? ' / ' + Math.round(expectedSize / 1048576) + ' MB' : ''));
          nextProgress += PROGRESS_EVERY;
        }
      }
      return { sha512: hash.digest('base64'), size };
    } catch (error) {
      lastError = error;
      console.log('第 ' + attempt + ' 趟下载失败：' + error.message
        + (attempt < ATTEMPTS ? '，从头重试' : ''));
    }
  }
  throw lastError ?? new Error('产物下载失败');
}

const channel = await fetchChannel();
const shape = checkChannelShape(channel);
if (shape.length > 0) {
  console.log('::error::' + target + ' 通道形态不合格 —— ' + shape.join('；'));
  process.exitCode = 1;
} else {
  const version = channel.get('version');
  const declared = channel.get('files')[0];
  const url = artifactUrlFor(declared.get('url'), target, ORIGIN);
  console.log('复核 ' + target + ' ' + version + '：' + url);
  const observed = await digestArtifact(url, Number(declared.get('size')));
  const problems = checkArtifactDigest(channel, observed);
  if (problems.length > 0) {
    console.log('::error::' + target + ' ' + version + ' 复核失败 —— ' + problems.join('；'));
    process.exitCode = 1;
  } else {
    const summary = '官方 ' + target + ' ' + version + ' 复核通过：' + observed.size
      + ' 字节，sha512 ' + observed.sha512.slice(0, 16) + '… 与通道声明一致';
    console.log('::notice::' + summary);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'summary=' + summary + '\n');
    }
  }
}
