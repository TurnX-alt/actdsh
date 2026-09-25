// 官方通道探针的离线回放：用本地 stub 冒充 download.deepseek.com，逐条验证分级判定真的会区分。
//
// 这条回路要守的不是解析（那在 official-desktop-feed.test.mjs 里），而是探针的
// 「什么算完整性破坏、什么只是世界变了」这条线：全都判 error 会让 mac-x64 的 404 长期染红，
// 全都判 warning 则通道说谎也没人知道。没有负控制就无法区分这两种退化。
//
// 与 pin-replay.test.mjs 同一约定：异步 execFile，不能用 spawnSync（stub 服务跑在本进程里）。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROBE = fileURLToPath(new URL('../probe-official-desktop.mjs', import.meta.url));
const FIX = (name) => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));

const winChannel = readFileSync(FIX('official-feed-win-x64.yml'), 'utf8');
const macChannel = readFileSync(FIX('official-feed-mac-arm64.yml'), 'utf8');
const WIN_SIZE = 288245480;
const MAC_SIZE = 372794444;
const REAL_ORIGIN = 'https://download.deepseek.com';

const CHANNELS = new Map([
  ['/dsh-desk/feeds/win-x64/nightly.yml', { body: winChannel, size: WIN_SIZE }],
  ['/dsh-desk/feeds/mac-arm64/nightly-mac.yml', { body: macChannel, size: MAC_SIZE }],
]);

// absent=三个通道都 404；missing-artifact=产物 404；wrong-size=字节数与声明不符；
// stale-tag=上游最新 tag 比通道旧（官方跑在 git 前面）。
let scenario = 'ok';
let requests = [];

const server = createServer((req, res) => serve(req, res));

let base = '';

function serve(req, res) {
  requests.push(req.method + ' ' + req.url);
  if (req.url === '/api/releases') {
    const tag = scenario === 'stale-tag' ? 'dsh-v0.1.7-rc.1' : 'dsh-v0.1.7-rc.2';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ tag_name: tag }]));
    return;
  }
  if (scenario === 'absent') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><html>DeepSeek App</html>');
    return;
  }
  const channel = CHANNELS.get(req.url);
  if (channel !== undefined) {
    // 真实通道里的 url 是绝对地址（指向 download.deepseek.com）。不重写的话，产物探测会
    // 绕过 stub 打到线上——测试看着绿，实际什么都没验，还会依赖外部网络。
    res.writeHead(200, { 'content-type': 'text/yaml' });
    res.end(channel.body.replaceAll(REAL_ORIGIN, base));
    return;
  }
  if (req.url.startsWith('/dsh-desk/bin/')) {
    if (scenario === 'missing-artifact') {
      res.writeHead(404);
      res.end();
      return;
    }
    const declared = req.url.includes('mac-arm64') ? MAC_SIZE : WIN_SIZE;
    res.writeHead(200, { 'content-length': String(scenario === 'wrong-size' ? declared - 1 : declared) });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
}

async function probeAs(next) {
  scenario = next;
  requests = [];
  base = 'http://127.0.0.1:' + String(server.address().port);
  const env = { ...process.env, DSH_OFFICIAL_FEED_ORIGIN: base, DSH_UPSTREAM_RELEASES_URL: base + '/api/releases' };
  delete env.GITHUB_TOKEN;
  try {
    const { stdout, stderr } = await run(process.execPath, [PROBE], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  } finally {
    scenario = 'ok';
  }
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('stub 与真实通道一致时探针通过，且确实探测了产物字节数', async () => {
  const { code, stdout } = await probeAs('ok');
  assert.equal(code, 0, stdout);
  assert.match(stdout, /win-x64 -> 0\.1\.7-rc\.2/);
  assert.match(stdout, /CDN 实际大小=288245480/);
  assert.match(stdout, /探针通过：2\/3 个通道一致/);
  // 每个在架 target 都要真的探过产物，否则「大小相符」这句结论是凭空写下的。
  assert.ok(requests.includes('HEAD /dsh-desk/bin/win-x64/deepseek-harness-0.1.7-rc.2-win-x64.exe'));
  assert.ok(requests.includes('HEAD /dsh-desk/bin/mac-arm64/deepseek-harness-0.1.7-rc.2-mac-arm64.zip'));
});

test('mac-x64 缺席只报 warning，不把探针判红', async () => {
  const { code, stdout } = await probeAs('ok');
  assert.equal(code, 0);
  assert.match(stdout, /::warning::mac-x64 通道不存在/);
  assert.match(stdout, /mac-x64 -> 通道不存在（404）/);
  assert.doesNotMatch(stdout, /::error::/);
});

test('通道说产物在、CDN 却说 404：完整性破坏，必须失败', async () => {
  const { code, stdout } = await probeAs('missing-artifact');
  assert.equal(code, 1, stdout);
  assert.match(stdout, /::error::win-x64：通道声明的产物返回 404/);
  assert.match(stdout, /::error::mac-arm64：通道声明的产物返回 404/);
});

test('产物字节数与通道声明不符时必须失败', async () => {
  const { code, stdout } = await probeAs('wrong-size');
  assert.equal(code, 1, stdout);
  assert.match(stdout, /与通道声明 288245480 不符/);
});

test('三个通道全部消失时不能当作「世界变了」放过', async () => {
  const { code, stdout } = await probeAs('absent');
  assert.equal(code, 1, stdout);
  assert.match(stdout, /::error::三个 target 的通道一个都没读到/);
  // 全部缺席时不该出现「探针通过」这种自相矛盾的结论
  assert.doesNotMatch(stdout, /探针通过/);
});

test('官方通道跑在上游 git tag 前面时报 warning 而非 error', async () => {
  const { code, stdout } = await probeAs('stale-tag');
  assert.equal(code, 0, stdout);
  assert.match(stdout, /::warning::官方通道版本 0\.1\.7-rc\.2 领先于上游最新 tag 0\.1\.7-rc\.1/);
});
