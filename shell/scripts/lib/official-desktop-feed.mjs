// 官方桌面版更新通道（electron-builder 生成的 nightly*.yml）的解析与判定，纯函数、无 IO。
//
// 为什么不直接正则取值，也不用 js-yaml：
// 1. 探针 job 刻意不装任何依赖（与 probe-upstream.yml 同一约定），引 YAML 库会破坏这一点；
// 2. 通道文件把 url/sha512/path 写成 `>-` 折叠块标量，长字符串会被折行；正则按「键后一行」直取
//    会在换行策略变化时静默读到半截 URL——静默错读比解析失败危险得多，因为探针的意义就是
//    「官方说这个产物在这儿且是这个哈希」。
// 所以这里只实现该文件实际用到的 YAML 子集，且任何看不懂的形态一律抛错。

import { compareVersions } from './version-line.mjs';

export const OFFICIAL_FEED_ORIGIN = 'https://download.deepseek.com';
export const OFFICIAL_RELEASE_PREFIX = 'dsh-desk';

// 上游 apps/desktop/scripts/desktop-auto-update-environment.mjs 里 UPDATE_TARGETS 的字面复制。
// 它决定「应该存在哪些通道」，与「实际存在哪些通道」的差集就是探针要报的东西。
export const OFFICIAL_FEED_TARGETS = ['win-x64', 'mac-arm64', 'mac-x64'];

export function channelFilename(target) {
  if (target === 'win-x64') return 'nightly.yml';
  if (target.startsWith('mac-')) return 'nightly-mac.yml';
  throw new Error('未知通道目标: ' + target);
}

export function feedUrlFor(target, origin = OFFICIAL_FEED_ORIGIN) {
  return origin + '/' + OFFICIAL_RELEASE_PREFIX + '/feeds/' + target + '/' + channelFilename(target);
}

export function artifactUrlFor(url, target, origin = OFFICIAL_FEED_ORIGIN) {
  if (/^https?:\/\//.test(url)) return url;
  return origin + '/' + OFFICIAL_RELEASE_PREFIX + '/bin/' + target + '/' + url;
}

// --- YAML 子集读取 ---

function toLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // 空行在本子集里没有语义（唯一的块标量是单行折叠的 URL/sha512），故直接丢弃。
    if (raw.trim() === '') continue;
    out.push({ indent: /^ */.exec(raw)[0].length, body: raw.trim() });
  }
  return out;
}

function foldScalar(style, parts) {
  return style[0] === '|' ? parts.join('\n') : parts.join(' ');
}

function unquote(value) {
  if (/^'[\s\S]*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^"[^"]*"$/.test(value)) return value.slice(1, -1);
  return value;
}

const KEY_RE = /^([^:]+):[ \t]*(.*)$/;
const BLOCK_SCALAR_RE = /^[|>][-+]?$/;

function parseMapping(lines, start, indent) {
  const map = new Map();
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error('第 ' + (i + 1) + ' 行缩进超出预期');
    const m = KEY_RE.exec(line.body);
    if (m === null) throw new Error('无法识别的行: ' + line.body);
    const key = m[1].trim();
    const rest = m[2].trim();
    i += 1;
    if (rest === '') {
      if (i >= lines.length || lines[i].indent <= indent) {
        map.set(key, null);
        continue;
      }
      const childIndent = lines[i].indent;
      if (lines[i].body.startsWith('- ')) {
        const [value, next] = parseSequence(lines, i, childIndent);
        map.set(key, value);
        i = next;
      } else {
        const [value, next] = parseMapping(lines, i, childIndent);
        map.set(key, value);
        i = next;
      }
      continue;
    }
    if (BLOCK_SCALAR_RE.test(rest)) {
      if (i >= lines.length || lines[i].indent <= indent) {
        map.set(key, '');
        continue;
      }
      const contentIndent = lines[i].indent;
      const parts = [];
      while (i < lines.length && lines[i].indent >= contentIndent) {
        parts.push(lines[i].body);
        i += 1;
      }
      map.set(key, foldScalar(rest, parts));
      continue;
    }
    map.set(key, unquote(rest));
  }
  return [map, i];
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith('- ')) {
    // 把 `- key: value` 改写成 keyIndent 处的一条映射首行，让同一套映射逻辑吃下去。
    const keyIndent = indent + 2;
    const merged = [{ indent: keyIndent, body: lines[i].body.slice(2).trim() }, ...lines.slice(i + 1)];
    const [value, consumed] = parseMapping(merged, 0, keyIndent);
    items.push(value);
    i += consumed;
  }
  return [items, i];
}

/**
 * 读入一份通道文件文本。只认映射 + 一层序列 + plain/单引号/折叠块标量；其余形态抛错，
 * 让探针在格式漂移时报「我们读不懂」而不是悄悄给出错值。
 */
export function parseChannel(text) {
  const lines = toLines(text);
  if (lines.length === 0) throw new Error('通道文件为空');
  const [map, consumed] = parseMapping(lines, 0, lines[0].indent);
  if (consumed !== lines.length) throw new Error('通道文件尾部有无法解析的内容');
  return map;
}

/** 校验通道文件的必备字段，返回问题描述数组（空数组即合格）。 */
export function checkChannelShape(channel) {
  const problems = [];
  const version = channel.get('version');
  if (typeof version !== 'string' || version === '') {
    problems.push('缺少 version');
  } else if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push('version 形态不认识: ' + version);
  }
  const files = channel.get('files');
  if (!Array.isArray(files)) {
    problems.push('files 不是列表');
    return problems;
  }
  // 上游 desktop-upload-plan.ts 要求 files 恰好一项；两项意味着通道被人工改过。
  if (files.length !== 1) {
    problems.push('files 有 ' + files.length + ' 项，应为 1 项');
    return problems;
  }
  const file = files[0];
  for (const key of ['url', 'sha512', 'size']) {
    const value = file.get(key);
    if (value === undefined || value === null || value === '') problems.push('files[0].' + key + ' 缺失');
  }
  const size = file.get('size');
  if (size !== undefined && !(Number.isSafeInteger(Number(size)) && Number(size) > 0)) {
    problems.push('files[0].size 不是正整数: ' + size);
  }
  const topUrl = channel.get('path');
  if (typeof topUrl === 'string' && typeof file.get('url') === 'string' && topUrl !== file.get('url')) {
    problems.push('path 与 files[0].url 不一致');
  }
  const topSha = channel.get('sha512');
  if (typeof topSha === 'string' && typeof file.get('sha512') === 'string' && topSha !== file.get('sha512')) {
    problems.push('sha512 与 files[0].sha512 不一致');
  }
  return problems;
}

/** 通道声明的产物是否真的可取回：非 200 即问题，声明大小与实际不符也是问题。 */
export function checkArtifactReachable(channel, head) {
  const problems = [];
  if (head.status !== 200) {
    problems.push('通道声明的产物返回 ' + head.status);
    return problems;
  }
  const declared = Number(channel.get('files')?.[0]?.get('size'));
  if (Number.isSafeInteger(declared) && Number.isSafeInteger(head.length) && declared !== head.length) {
    problems.push('产物实际大小 ' + head.length + ' 与通道声明 ' + declared + ' 不符');
  }
  return problems;
}

/**
 * 各通道版本是否一致。部分发布（一个平台先动）在这里现形。
 * @returns {{ version: string|null, offenders: Array<{target: string, version: string}> }}
 */
export function findVersionDisagreement(versionsByTarget) {
  const present = [...versionsByTarget.entries()].filter(([, version]) => typeof version === 'string');
  if (present.length === 0) return { version: null, offenders: [] };
  const counts = new Map();
  for (const [, version] of present) counts.set(version, (counts.get(version) ?? 0) + 1);
  const [version] = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareVersions(b[0], a[0]))[0];
  return {
    version,
    offenders: present.filter(([, v]) => v !== version).map(([target, v]) => ({ target, version: v })),
  };
}

/** 官方通道版本是否已领先于上游 git 上最新的 dsh 版本（发了安装包没发 tag）。 */
export function isAheadOfUpstream(channelVersion, upstreamVersion) {
  if (typeof channelVersion !== 'string' || typeof upstreamVersion !== 'string') return false;
  return compareVersions(channelVersion, upstreamVersion) > 0;
}
