// 官方桌面版更新通道探针：观测官方 CDN 的发布通道本身，而不是观测 git tag。
//
// 为什么需要它：上游 GitHub Releases 的 dsh-v* 全部 0 assets，桌面版只经
// https://download.deepseek.com/dsh-desk/ 分发。actdsh 在 2026-09-25 把自身定位收缩为
// 「官方桌面版的可复现构建与独立校验」（地图 #17 的 D1/D2）之后，官方通道的实际状态
// 成了本仓库的输入：它发没发、发到哪个版本、声明的产物取不取回来，必须先知道。
//
// 与 release-desktop.yml 无 needs 关系，失败不阻塞发布。
//
// 分级（刻意区分 error 与 warning，否则已知事实会把探针长期染红）：
//   error   —— 通道读不出 version / 必备字段缺失 / path 与 files[0].url 不一致
//   error   —— 通道声明的产物取不回（非 200）或大小与声明不符
//   warning —— 某个 target 的通道 404（mac-x64 当前即此状态：Intel Mac 未发布）
//   warning —— 各 target 版本不一致（部分发布）
//   warning —— 官方通道版本领先于上游最新 dsh-v* tag（发了安装包没发 tag）
//
// 用法: node shell/scripts/probe-official-desktop.mjs
// 退出码用 process.exitCode 而非 process.exit()：本脚本留着未关闭的 fetch 连接，
// Windows 上 process.exit() 会在 libuv 断言处崩溃（实测 0xC0000409），把 1 变成别的数。
import {
  OFFICIAL_FEED_TARGETS,
  artifactUrlFor,
  checkArtifactReachable,
  checkChannelShape,
  feedUrlFor,
  findVersionDisagreement,
  isAheadOfUpstream,
  parseChannel,
} from './lib/official-desktop-feed.mjs';

const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';
const ORIGIN = (process.env.DSH_OFFICIAL_FEED_ORIGIN ?? 'https://download.deepseek.com').replace(/\/+$/, '');
// 测试里指向本地 stub：不注入就会让离线测试依赖 api.github.com 的匿名配额。
const UPSTREAM_RELEASES_URL = process.env.DSH_UPSTREAM_RELEASES_URL
  ?? 'https://api.github.com/repos/' + UPSTREAM_REPO + '/releases?per_page=20';
const ATTEMPTS = 3;

// 与钉死脚本同一教训：瞬断会把「取不到」误判成「没有」，而分级告警一旦抖动就失去意义。
async function request(url, init = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('request failed for ' + url);
}

async function readChannel(target) {
  const url = feedUrlFor(target, ORIGIN);
  const res = await request(url, { headers: { accept: 'text/yaml, text/plain, */*' } });
  if (res.status === 404) return { target, state: 'absent', url };
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  const channel = parseChannel(await res.text());
  return { target, state: 'present', url, channel };
}

// HEAD 不被 CDN 支持时退回只取 1 字节的 GET；状态码 206 同样算可达。
async function probeArtifact(url) {
  const head = await request(url, { method: 'HEAD' });
  if (head.status === 405 || head.status === 501) {
    const ranged = await request(url, { headers: { range: 'bytes=0-0' } });
    return { status: ranged.status === 206 ? 200 : ranged.status, length: Number(ranged.headers.get('content-length')) };
  }
  const declaredLength = Number(head.headers.get('content-length'));
  return { status: head.status, length: Number.isSafeInteger(declaredLength) ? declaredLength : NaN };
}

async function latestUpstreamVersion() {
  const headers = process.env.GITHUB_TOKEN === undefined ? {} : { authorization: 'Bearer ' + process.env.GITHUB_TOKEN };
  const res = await request(UPSTREAM_RELEASES_URL, { headers });
  if (!res.ok) throw new Error('上游 releases 列表 -> HTTP ' + res.status);
  const tag = (await res.json()).find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('dsh-v'))?.tag_name;
  return tag === undefined ? undefined : tag.replace(/^dsh-v/, '');
}

const errors = [];
const warnings = [];
const readings = [];

for (const target of OFFICIAL_FEED_TARGETS) {
  let reading;
  try {
    reading = await readChannel(target);
  } catch (error) {
    errors.push(target + '：通道读取失败 ' + error.message);
    readings.push({ target, state: 'unreachable' });
    continue;
  }
  if (reading.state === 'absent') {
    readings.push(reading);
    continue;
  }
  const shape = checkChannelShape(reading.channel);
  if (shape.length > 0) {
    errors.push(target + '：通道形态不合格 —— ' + shape.join('；'));
    readings.push(reading);
    continue;
  }
  const file = reading.channel.get('files')[0];
  const artifact = artifactUrlFor(file.get('url'), target, ORIGIN);
  try {
    const head = await probeArtifact(artifact);
    const reachable = checkArtifactReachable(reading.channel, head);
    if (reachable.length > 0) {
      errors.push(target + '：' + reachable.join('；') + ' —— ' + artifact);
    }
    readings.push({ ...reading, version: reading.channel.get('version'), size: file.get('size'), releaseDate: reading.channel.get('releaseDate'), head });
  } catch (error) {
    errors.push(target + '：产物探测失败 ' + error.message);
    readings.push({ ...reading, version: reading.channel.get('version'), size: file.get('size'), releaseDate: reading.channel.get('releaseDate') });
  }
}

console.log('官方桌面版通道（' + ORIGIN + '/dsh-desk/feeds/）：');
for (const reading of readings) {
  if (reading.state === 'absent') {
    console.log('  ' + reading.target + ' -> 通道不存在（404）');
    warnings.push(reading.target + ' 通道不存在：该平台未发布');
    continue;
  }
  if (reading.state === 'unreachable') {
    console.log('  ' + reading.target + ' -> 读取失败');
    continue;
  }
  console.log('  ' + reading.target + ' -> ' + reading.version
    + '  大小=' + reading.size
    + '  声明时间=' + reading.releaseDate
    + (Number.isNaN(reading.head?.length) ? '' : '  CDN 实际大小=' + reading.head.length));
}

const disagreement = findVersionDisagreement(new Map(readings.map((r) => [r.target, r.version ?? null])));
if (disagreement.offenders.length > 0) {
  warnings.push('各平台通道版本不一致（部分发布）：' 
    + disagreement.offenders.map((o) => o.target + '=' + o.version).join('、')
    + '，多数为 ' + disagreement.version);
}

let upstream;
try {
  upstream = await latestUpstreamVersion();
} catch (error) {
  // 上游 tag 只用于「官方是否跑在 git 前面」这一条预警，读不到不该把探针判红。
  console.log('上游 dsh-v* 最新 tag 读取失败，跳过领先性判断：' + error.message);
}
if (upstream !== undefined && disagreement.version !== null) {
  console.log('上游最新 dsh release: ' + upstream);
  if (isAheadOfUpstream(disagreement.version, upstream)) {
    warnings.push('官方通道版本 ' + disagreement.version + ' 领先于上游最新 tag ' + upstream + '（发了安装包没发 tag）');
  }
}

for (const warning of warnings) console.log('::warning::' + warning);
for (const error of errors) console.log('::error::' + error);

const present = readings.filter((r) => r.state === 'present').length;
if (errors.length > 0) {
  console.error('探针失败：' + errors.length + ' 项完整性问题。');
  process.exitCode = 1;
} else if (present === 0) {
  // 全部 404 与单个 target 404 不是一回事：前者意味着官方分发疑似整体停摆，不能降级成 warning。
  console.log('::error::三个 target 的通道一个都没读到，官方桌面版分发疑似整体不可用。');
  console.error('探针失败：没有任何通道可读。');
  process.exitCode = 1;
} else {
  console.log('探针通过：' + present + '/' + OFFICIAL_FEED_TARGETS.length + ' 个通道一致。');
}
