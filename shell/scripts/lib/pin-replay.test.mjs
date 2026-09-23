// pin-upstream.mjs 的离线回放：用录制的 registry fixture 起一个本地 stub 服务，
// 用 replay-install-stub.mjs 取代 npm install，在临时目录里跑完整脚本路径
// （BFS → 选版 → 写 manifest → 安装 → 扫树 → 三处闸门 → 写清单）。
//
// 这条回路存在的理由：这段逻辑此前只在发布路径上跑，一次要装 267 个包、
// 依赖实时网络，既慢又不稳定，因此长期零测试覆盖——2026-09-23 的发布失败
// 就是这么漏出去的。回放把它压到秒级、离线、确定性。
//
// 注意：必须用异步 execFile，不能用 spawnSync。stub registry 就跑在本测试进程里，
// spawnSync 会阻塞事件循环，服务无法接受连接，子进程只会一路 fetch 超时。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PIN_SCRIPT = fileURLToPath(new URL('../pin-upstream.mjs', import.meta.url));
const STUB = join(HERE, 'replay-install-stub.mjs');
const FIXTURE = join(HERE, 'fixtures', 'pin-0.1.7-alpha.2.json');
const TAG = '0.1.7-alpha.2';
const LOK = '@deepseek-ai/libreoffice-kit';

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// 把投影还原成脚本认识的 packument 形状：versions 的每个键都要在，
// 但只有被投影保留的那两个版本带依赖信息（脚本也只读那两个）。
function toPackument(name) {
  const pkg = fixture.packages[name];
  if (pkg === undefined) return undefined;
  const versions = {};
  for (const v of pkg.versions) versions[v] = pkg.manifests[v] ?? {};
  return { name, versions };
}

let server;
let registryUrl;
let hits = 0;
const tempDirs = [];

before(async () => {
  server = createServer((req, res) => {
    hits += 1;
    const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
    const packument = toPackument(name);
    if (packument === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(packument));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  registryUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// 生成平台对应的 npm 替身包装脚本。Windows 上 pin-upstream 以 shell:true 调用 npm，
// 用 .cmd；POSIX 上需要可执行位。
function writeNpmWrapper(dir) {
  if (process.platform === 'win32') {
    const p = join(dir, 'npm-stub.cmd');
    writeFileSync(p, `@echo off\r\nnode "${STUB}" %*\r\n`);
    return p;
  }
  const p = join(dir, 'npm-stub.sh');
  writeFileSync(p, `#!/bin/sh\nexec node "${STUB}" "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

async function runPin(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'actdsh-pin-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'actdsh-runtime',
    version: '0.0.0',
    private: true,
    // 非家族依赖必须被原样保留，用来验证 buildDependencies 不会误删
    dependencies: { electron: '^37.0.0' },
  }, null, 2) + '\n');
  const options = {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      DSH_PIN_REGISTRY: registryUrl,
      DSH_PIN_NPM: writeNpmWrapper(dir),
      PIN_REPLAY_FIXTURE: FIXTURE,
      ...extraEnv,
    },
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [PIN_SCRIPT, TAG], options);
    return { dir, status: 0, out: stdout + stderr };
  } catch (error) {
    return { dir, status: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

describe('pin-upstream.mjs 离线回放', () => {
  test('完整跑通：267 同版本线 / 9 独立线 / 26 peer 补齐，与真实 registry 一致', async () => {
    const { status, out, dir } = await runPin();
    assert.equal(status, 0, '脚本应成功退出，输出:\n' + out);
    assert.match(out, /同版本线包 267 个；独立版本线 9 个/);
    assert.match(out, /peer 显式补齐 26 个/);

    const report = JSON.parse(readFileSync(join(dir, 'upstream-versions.json'), 'utf8'));
    assert.equal(report.tag, TAG);
    assert.equal(report.pinnedCount, 267);
    assert.equal(Object.keys(report.independent).length, 9);
    // 清单必须是观测结果：libreoffice-kit 记录的是实际装进去的版本
    assert.equal(report.independent[LOK], '0.0.1');
  });

  // 这是本次事故的核心回归断言。修复前独立线取 latestStable 得 0.1.0，
  // 而 dsh-office-to-pdf 精确锁 0.0.1，于是树里两份副本、清单报告一个没人用的版本。
  test('libreoffice-kit 跟随 dsh-office-to-pdf 的精确声明落到 0.0.1，且不被顶层声明', async () => {
    const { status, out, dir } = await runPin();
    assert.equal(status, 0, out);
    assert.match(out, /@deepseek-ai\/libreoffice-kit@0\.0\.1/);

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    // 有 dep 边的独立线包不写进 dependencies，交给 npm 按声明解析
    assert.equal(manifest.dependencies[LOK], undefined);
    assert.equal(manifest.overrides[LOK], undefined);
    // 主包与 peer 补齐包仍显式声明
    assert.equal(manifest.dependencies['@deepseek-ai/dsh'], TAG);
    assert.equal(manifest.dependencies['@deepseek-ai/cordis-plugin-group'], '1.0.4');
    // 非家族依赖原样保留
    assert.equal(manifest.dependencies.electron, '^37.0.0');
    // 同版本线全部进 overrides
    assert.equal(Object.keys(manifest.overrides).length, 267);
    assert.ok(Object.values(manifest.overrides).every((v) => v === TAG));

    // 树里只有一份 libreoffice-kit，就在顶层，版本正是上游声明的那个
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', LOK, 'package.json'), 'utf8'));
    assert.equal(installed.version, '0.0.1');
  });

  // 树扫描从两条固定深度 glob 改成了递归下探；这条用例证明深层副本真的被看到。
  // 旧写法只覆盖 node_modules/*/*/node_modules/@deepseek-ai/*，第 3 层及更深会被漏掉，
  // 而「同版本线全树等于 tag 版本」这个不变量要求覆盖全树。
  test('纯度闸门：3 层深的嵌套漂移也要被发现（旧 glob 会漏掉）', async () => {
    const { status, out } = await runPin({
      PIN_REPLAY_NEST: [
        'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules',
        '@deepseek-ai/dsh-util-time',
        '0.1.5',
      ].join('|'),
    });
    assert.equal(status, 1, '深层漂移应让脚本失败，输出:\n' + out);
    assert.match(out, /钉死失败，仍漂移/);
    assert.match(out, /@deepseek-ai\/dsh-util-time@0\.1\.5/);
  });

  // 负控制之一：同版本线漂移必须被发现。
  test('纯度闸门：同版本线包顶层版本漂移时退出非零', async () => {
    const { status, out } = await runPin({
      PIN_REPLAY_CORRUPT: '@deepseek-ai/dsh-base',
      PIN_REPLAY_CORRUPT_VERSION: '0.1.6',
    });
    assert.equal(status, 1);
    assert.match(out, /钉死失败，仍漂移/);
    assert.match(out, /@deepseek-ai\/dsh-base@0\.1\.6/);
  });

  // 负控制之二：证明 #9 的闸门仍有鉴别力——不是把断言放宽才变绿的。
  test('纯度闸门：独立线顶层版本不满足声明区间时退出非零', async () => {
    const { status, out } = await runPin({
      PIN_REPLAY_CORRUPT: LOK,
      PIN_REPLAY_CORRUPT_VERSION: '0.1.0',
    });
    assert.equal(status, 1);
    assert.match(out, /独立版本线未按记录版本安装/);
    assert.match(out, /不满足声明区间 0\.0\.1/);
  });

  test('回放确实命中了 stub registry，而非真实网络', async () => {
    await runPin();
    assert.ok(hits > 200, '本地 stub 应被大量命中，实际 ' + hits);
  });
});
