import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  artifactUrlFor,
  channelFilename,
  checkArtifactReachable,
  checkChannelShape,
  feedUrlFor,
  findVersionDisagreement,
  isAheadOfUpstream,
  parseChannel,
} from './official-desktop-feed.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const realWin = readFileSync(new URL('official-feed-win-x64.yml', FIXTURES), 'utf8');
const realMac = readFileSync(new URL('official-feed-mac-arm64.yml', FIXTURES), 'utf8');

test('通道 URL 与上游 desktop-auto-update-environment.mjs 的拼法一致', () => {
  assert.equal(
    feedUrlFor('win-x64'),
    'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
  );
  assert.equal(
    feedUrlFor('mac-arm64'),
    'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
  );
  assert.equal(channelFilename('mac-x64'), 'nightly-mac.yml');
  assert.throws(() => channelFilename('linux-x64'), /未知通道目标/);
});

test('真实 win 通道：折叠块标量里的 url 与 sha512 被完整读出', () => {
  const channel = parseChannel(realWin);
  assert.equal(channel.get('version'), '0.1.7-rc.2');
  assert.equal(
    channel.get('files')[0].get('url'),
    'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe',
  );
  assert.equal(
    channel.get('files')[0].get('sha512'),
    'AY7f45dYO7BFrfgaLmzXNWP0pavlxkSbsehPo/WF6PXcFdDK3fF1oHUPs/4f2bzROgQvm6wSgawZ/g7UzbPRmw==',
  );
  assert.equal(channel.get('files')[0].get('size'), '288245480');
  assert.equal(channel.get('releaseDate'), '2026-09-24T14:11:01.715Z');
  assert.deepEqual(checkChannelShape(channel), []);
});

test('真实 mac 通道同样合格（缩进与 win 不同：序列项在 files 下两级）', () => {
  const channel = parseChannel(realMac);
  assert.equal(channel.get('version'), '0.1.7-rc.2');
  assert.match(channel.get('files')[0].get('url'), /mac-arm64\.zip$/);
  assert.deepEqual(checkChannelShape(channel), []);
});

test('产物 url 写成裸文件名时按 bin 前缀拼接，已是绝对地址则原样用', () => {
  assert.equal(
    artifactUrlFor('deepseek-harness-1.2.3-win-x64.exe', 'win-x64'),
    'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-1.2.3-win-x64.exe',
  );
  assert.equal(artifactUrlFor('https://other.example.com/a.exe', 'win-x64'), 'https://other.example.com/a.exe');
});

// ---- 判定必须真的会区分，否则绿灯无意义 ----

test('files 出现两项时报错，而不是取第一项蒙过去', () => {
  const channel = parseChannel([
    'version: 1.2.3',
    'files:',
    '  - url: >-',
    '      https://download.deepseek.com/a.exe',
    '    sha512: AAA=',
    '    size: 10',
    '  - url: >-',
    '      https://download.deepseek.com/b.exe',
    '    sha512: BBB=',
    '    size: 20',
  ].join('\n'));
  assert.deepEqual(checkChannelShape(channel), ['files 有 2 项，应为 1 项']);
});

test('url 缺 sha512 时 checkChannelShape 只报缺失那一项', () => {
  const channel = parseChannel('version: 1.2.3\nfiles:\n  - url: https://download.deepseek.com/a.exe\n    size: 10\n');
  assert.deepEqual(checkChannelShape(channel), ['files[0].sha512 缺失']);
});

test('path 与 files[0].url 不一致时报错（通道被手工编辑过的痕迹）', () => {
  const channel = parseChannel([
    'version: 1.2.3',
    'files:',
    '  - url: https://download.deepseek.com/a.exe',
    '    sha512: AAA=',
    '    size: 10',
    'path: https://download.deepseek.com/evil.exe',
  ].join('\n'));
  assert.deepEqual(checkChannelShape(channel), ['path 与 files[0].url 不一致']);
});

test('version 缺失或非 semver 形态时报错', () => {
  assert.deepEqual(checkChannelShape(parseChannel('files:\n  - url: u\n    sha512: s\n    size: 1\n')), ['缺少 version']);
  assert.deepEqual(
    checkChannelShape(parseChannel('version: nightly-latest\nfiles:\n  - url: u\n    sha512: s\n    size: 1\n')),
    ['version 形态不认识: nightly-latest'],
  );
});

test('size 非正整数时报错', () => {
  const channel = parseChannel('version: 1.2.3\nfiles:\n  - url: u\n    sha512: s\n    size: -5\n');
  assert.deepEqual(checkChannelShape(channel), ['files[0].size 不是正整数: -5']);
});

// ---- 换行/引号策略漂移：读法不能依赖 js-yaml 恰好用 >- ----

test('同一条通道换成 plain 标量（不折叠）时解析结果不变', () => {
  const folded = parseChannel(realWin);
  const plain = parseChannel([
    'version: 0.1.7-rc.2',
    'files:',
    '  - url: https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe',
    '    sha512: AY7f45dYO7BFrfgaLmzXNWP0pavlxkSbsehPo/WF6PXcFdDK3fF1oHUPs/4f2bzROgQvm6wSgawZ/g7UzbPRmw==',
    '    size: 288245480',
    'path: https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe',
    'sha512: AY7f45dYO7BFrfgaLmzXNWP0pavlxkSbsehPo/WF6PXcFdDK3fF1oHUPs/4f2bzROgQvm6wSgawZ/g7UzbPRmw==',
    'releaseDate: 2026-09-24T14:11:01.715Z',
  ].join('\n'));
  assert.equal(plain.get('files')[0].get('url'), folded.get('files')[0].get('url'));
  assert.equal(plain.get('files')[0].get('sha512'), folded.get('files')[0].get('sha512'));
  assert.equal(plain.get('releaseDate'), folded.get('releaseDate'));
});

test('块标量真的跨行折叠时按空格接回一行', () => {
  const channel = parseChannel('path: >-\n  https://download.deepseek.com/dsh-desk\n  /bin/win-x64/a.exe\n');
  assert.equal(channel.get('path'), 'https://download.deepseek.com/dsh-desk /bin/win-x64/a.exe');
});

test('看不懂的行一律抛错，不静默产出空通道', () => {
  assert.throws(() => parseChannel(''), /通道文件为空/);
  assert.throws(() => parseChannel('- just a bare item\n'), /无法识别的行/);
  assert.throws(() => parseChannel('version: 1.2.3\n  nested: too deep\n'), /缩进超出预期/);
});

// ---- 产物可达性 ----

test('通道声明的产物返回 404 时报错', () => {
  const channel = parseChannel(realWin);
  assert.deepEqual(checkArtifactReachable(channel, { status: 404 }), ['通道声明的产物返回 404']);
});

test('产物大小与通道声明不符时报错（CDN 上换了字节却没更新通道）', () => {
  const channel = parseChannel(realWin);
  assert.deepEqual(
    checkArtifactReachable(channel, { status: 200, length: 1 }),
    ['产物实际大小 1 与通道声明 288245480 不符'],
  );
});

test('产物大小与声明一致时通过', () => {
  const channel = parseChannel(realWin);
  assert.deepEqual(checkArtifactReachable(channel, { status: 200, length: 288245480 }), []);
});

// ---- 跨通道一致性 ----

test('各通道版本一致时无偏离者', () => {
  const r = findVersionDisagreement(new Map([['win-x64', '0.1.7-rc.2'], ['mac-arm64', '0.1.7-rc.2']]));
  assert.equal(r.version, '0.1.7-rc.2');
  assert.deepEqual(r.offenders, []);
});

test('只有一个平台先发布时，偏离者指向它（部分发布现形）', () => {
  const r = findVersionDisagreement(new Map([
    ['win-x64', '0.1.7-rc.3'],
    ['mac-arm64', '0.1.7-rc.2'],
    ['mac-x64', '0.1.7-rc.2'],
  ]));
  assert.equal(r.version, '0.1.7-rc.2');
  assert.deepEqual(r.offenders, [{ target: 'win-x64', version: '0.1.7-rc.3' }]);
});

test('全部通道缺席时不臆造版本', () => {
  assert.deepEqual(findVersionDisagreement(new Map([['mac-x64', null]])), { version: null, offenders: [] });
});

// ---- 与上游 git 的相对位置 ----

test('官方通道领先于上游 tag 时被识别；相等或落后则否', () => {
  assert.equal(isAheadOfUpstream('0.1.7-rc.3', '0.1.7-rc.2'), true);
  assert.equal(isAheadOfUpstream('0.1.7-rc.2', '0.1.7-rc.2'), false);
  assert.equal(isAheadOfUpstream('0.1.7-rc.1', '0.1.7-rc.2'), false);
  // 同号的 stable 高于 prerelease：通道已出 0.1.7 而 git 最新只是 0.1.7-rc.2，正是「发了安装包没发 tag」
  assert.equal(isAheadOfUpstream('0.1.7', '0.1.7-rc.2'), true);
  assert.equal(isAheadOfUpstream('0.1.7-rc.2', '0.1.7'), false);
});

test('版本信息缺失时不做领先判断', () => {
  assert.equal(isAheadOfUpstream(undefined, '0.1.7-rc.2'), false);
  assert.equal(isAheadOfUpstream('0.1.7-rc.2', undefined), false);
});
