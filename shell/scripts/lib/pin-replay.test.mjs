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
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PIN_SCRIPT = fileURLToPath(new URL('../pin-upstream.mjs', import.meta.url));
const PROBE_SCRIPT = fileURLToPath(new URL('../probe-upstream.mjs', import.meta.url));
const STUB = join(HERE, 'replay-install-stub.mjs');
const LOK = '@deepseek-ai/libreoffice-kit';
const SETTINGS = '@deepseek-ai/dsh-client-ui-settings-account';
// alpha2 图的 tag；块内断言沿用命名常量，避免把 0.1.7-alpha.2 散落各处。
const TAG = '0.1.7-alpha.2';

// 两份 fixture 各自守不同的形态，不能用新的替换旧的：
//   0.1.7-alpha.2 —— libreoffice-kit 被 dsh-office-to-pdf 精确锁 0.0.1，正是 ADR 0001
//                    要修的那个形状。删掉这份，重构的回归断言就没有载体了。
//   0.2.0-rc.2   —— 当前真实图，且带着 2026-09-29 事故的同款声明边：dsh-web-app 精确
//                    声明 settings-account@0.2.0-rc.2。抹掉那一个版本就能离线复现竞态。
const GRAPHS = {
  alpha2: { file: 'pin-0.1.7-alpha.2.json', tag: '0.1.7-alpha.2' },
  rc2: { file: 'pin-0.2.0-rc.2.json', tag: '0.2.0-rc.2' },
};

function loadFixture(entry) {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', entry.file), 'utf8'));
}

// 把投影还原成脚本认识的 packument 形状：versions 的每个键都要在，
// 但只有被投影保留的那两个版本带依赖信息（脚本也只读那两个）。
// nopublish 用于复现「上游还没发齐」：把该包的 tag 版本从版本列表里抹掉，
// 于是它被分到独立线，而精确声明无人满足——与 2026-09-29 的真实故障同形。
function toPackument(fixture, tag, nopublish, name) {
  const pkg = fixture.packages[name];
  if (pkg === undefined) return undefined;
  const versions = {};
  for (const v of pkg.versions) {
    if (name === nopublish && v === tag) continue;
    versions[v] = pkg.manifests[v] ?? {};
  }
  return { name, versions };
}

const tempDirs = [];
const openServers = [];

// 每个场景一套 registry：nopublish 是运行时行为，不适合挂在共享服务上。
async function startRegistry(graph, options = {}) {
  const entry = GRAPHS[graph];
  const fixture = loadFixture(entry);
  const state = { hits: 0, url: '', tag: entry.tag, file: entry.file };
  state.server = createServer((req, res) => {
    state.hits += 1;
    const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
    const packument = toPackument(fixture, entry.tag, options.nopublish, name);
    if (packument === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(packument));
  });
  await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${state.server.address().port}`;
  openServers.push(state.server);
  return state;
}

afterEach(() => {
  while (openServers.length > 0) openServers.pop().close();
});

after(() => {
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

async function runPin(graph, extraEnv = {}) {
  const registry = await startRegistry(graph, { nopublish: extraEnv.PIN_REPLAY_NOPUBLISH });
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
      DSH_PIN_REGISTRY: registry.url,
      DSH_PIN_NPM: writeNpmWrapper(dir),
      PIN_REPLAY_FIXTURE: join(HERE, 'fixtures', GRAPHS[graph].file),
      ...extraEnv,
    },
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [PIN_SCRIPT, registry.tag], options);
    return { dir, status: 0, out: stdout + stderr, registry };
  } catch (error) {
    return { dir, status: error.code, out: (error.stdout ?? '') + (error.stderr ?? ''), registry };
  }
}

// 探针与钉死脚本共用同一个 registry 注入口，所以同一份 fixture 既能验「构建会响亮失败」，
// 也能验「poll 预检会报退出码 3」——昨天那条链路上两半的行为都得离线可证。
async function runProbe(graph, extraEnv = {}) {
  const registry = await startRegistry(graph, { nopublish: extraEnv.PIN_REPLAY_NOPUBLISH });
  const options = {
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DSH_PIN_REGISTRY: registry.url, ...extraEnv },
  };
  delete options.env.GITHUB_TOKEN;
  try {
    const { stdout, stderr } = await run(process.execPath, [PROBE_SCRIPT, registry.tag], options);
    return { status: 0, out: stdout + stderr, registry };
  } catch (error) {
    return { status: error.code, out: (error.stdout ?? '') + (error.stderr ?? ''), registry };
  }
}

describe('pin-upstream.mjs 离线回放（0.1.7-alpha.2 图：精确锁回归形态）', () => {
  test('完整跑通：267 同版本线 / 9 独立线 / 26 peer 补齐，与真实 registry 一致', async () => {
    const { status, out, dir } = await runPin('alpha2');
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
    const { status, out, dir } = await runPin('alpha2');
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
    const { status, out } = await runPin('alpha2', {
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
    const { status, out } = await runPin('alpha2', {
      PIN_REPLAY_CORRUPT: '@deepseek-ai/dsh-base',
      PIN_REPLAY_CORRUPT_VERSION: '0.1.6',
    });
    assert.equal(status, 1);
    assert.match(out, /钉死失败，仍漂移/);
    assert.match(out, /@deepseek-ai\/dsh-base@0\.1\.6/);
  });

  // 负控制之二：证明 #9 的闸门仍有鉴别力——不是把断言放宽才变绿的。
  test('纯度闸门：独立线顶层版本不满足声明区间时退出非零', async () => {
    const { status, out } = await runPin('alpha2', {
      PIN_REPLAY_CORRUPT: LOK,
      PIN_REPLAY_CORRUPT_VERSION: '0.1.0',
    });
    assert.equal(status, 1);
    assert.match(out, /独立版本线未按记录版本安装/);
    assert.match(out, /不满足声明区间 0\.0\.1/);
  });

  test('回放确实命中了 stub registry，而非真实网络', async () => {
    const { registry } = await runPin('alpha2');
    assert.ok(registry.hits > 200, '本地 stub 应被大量命中，实际 ' + registry.hits);
  });
});

// 当前真实图。守的是 2026-09-29 那次发布失败的同形场景：成员包还没发齐时，
// 构建路径必须响亮失败、预检路径必须报「等一轮」，两者都不能静默降级。
// 负控制：基线落后必须真的报出来，否则 #30 的触发点只是注释。
// 只读基线目录的文件名，所以给个旧名的空壳文件即可，不必复制 300 KB 真实内容。
test('回放基线落后时探针给出重录提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'actdsh-baseline-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'pin-0.1.7-alpha.2.json'), '{}\n');
  const { status, out } = await runProbe('rc2', { DSH_PIN_FIXTURE_DIR: dir });
  assert.equal(status, 0, out);
  assert.match(out, /回放基线落后：最新 fixture 是 0\.1\.7-alpha\.2，实时 tag 是 0\.2\.0-rc\.2/);
  assert.match(out, /record-pin-fixture\.mjs 0\.2\.0-rc\.2/);
  assert.match(out, /不得就地覆盖/, '提示必须是追加录制，覆盖历史基线会让「与那次发布一致」的断言无声失效');
});

test('基线正是当前 tag 时探针不报落后（防止天天误报）', async () => {
  const { status, out } = await runProbe('rc2');
  assert.equal(status, 0, out);
  assert.doesNotMatch(out, /回放基线落后/);
});

describe('pin-upstream.mjs 离线回放（0.2.0-rc.2 图：当前形态与发布竞态）', () => {
  test('完整跑通：278 同版本线 / 9 独立线，独立线取值与上游声明区间逐一对齐', async () => {
    const RC2_TAG = GRAPHS.rc2.tag;
    const { status, out, dir } = await runPin('rc2');
    assert.equal(status, 0, '脚本应成功退出，输出:\n' + out);
    assert.match(out, new RegExp('同版本线包 278 个；独立版本线 9 个'));

    const report = JSON.parse(readFileSync(join(dir, 'upstream-versions.json'), 'utf8'));
    assert.equal(report.tag, RC2_TAG);
    assert.equal(report.pinnedCount, 278);
    // 与 2026-09-29 真实发布清单逐包对照；唯一差异是 libreoffice-kit（见下条用例）
    assert.deepEqual(report.independent, {
      '@deepseek-ai/cordis': '4.0.4',
      '@deepseek-ai/cordis-plugin-group': '1.0.4',
      '@deepseek-ai/cordis-plugin-include': '1.0.9',
      '@deepseek-ai/cordis-plugin-loader': '1.0.5',
      '@deepseek-ai/cordis-plugin-timer': '1.1.6',
      '@deepseek-ai/cosmokit': '1.8.5',
      '@deepseek-ai/libreoffice-kit': '0.1.3',
      '@deepseek-ai/node-addon-system': '0.1.2',
      '@deepseek-ai/schemastery': '3.18.4',
    });
    assert.equal(report.independent[LOK], '0.1.3');
  });

  // 这条不是断言松紧问题，是 #30 的核心结论：fixture 与真实发布清单在 libreoffice-kit
  // 上必然不同——发布当天（09-29 12:33Z）npm 上只有到 0.1.2，今天录制的是 0.1.3。
  // 两者都满足 ^0.1.1，所以差异不是 bug，而是「就地重录会改写历史基线」的实证。
  test('独立线跟随区间而非历史发布：^0.1.1 在今天 admits 0.1.3', async () => {
    const { status, out } = await runPin('rc2');
    assert.equal(status, 0, out);
    assert.match(out, /@deepseek-ai\/libreoffice-kit@0\.1\.3/);
    assert.doesNotMatch(out, /libreoffice-kit@0\.1\.2/, '0.1.2 也满足区间，但区间内最高者才是答案');
  });

  // 负控制：复现 2026-09-29 的故障形状。dsh-web-app 精确声明 settings-account@0.2.0-rc.2，
  // 抹掉该版本后构建路径必须失败并点名，而不是悄悄改用 0.2.0-rc.1 把包发出去。
  test('发布竞态：成员包缺 tag 版本时钉死响亮失败并点名', async () => {
    const { status, out } = await runPin('rc2', { PIN_REPLAY_NOPUBLISH: SETTINGS });
    assert.equal(status, 1, '缺失应让脚本失败，输出:\n' + out);
    assert.match(out, /没有任何已发布版本能同时满足声明区间/);
    assert.match(out, /dsh-client-ui-settings-account/);
  });

  // 同一份 registry 驱动探针：poll 靠这个退出码决定空转还是构建，所以它必须可离线证伪。
  test('发布竞态：探针在同一缺口上报退出码 3 并列出等待清单', async () => {
    const { status, out } = await runProbe('rc2', { PIN_REPLAY_NOPUBLISH: SETTINGS });
    assert.equal(status, 3, '退出码应为 3（等一轮），输出:\n' + out);
    assert.match(out, /闭包尚未发布完整/);
    assert.match(out, /缺 0\.2\.0-rc\.2：@deepseek-ai\/dsh-client-ui-settings-account/);
  });

  // 负控制的对照：闭包完整时探针必须报 0，否则「等一轮」会变成永远等、poll 天天空转。
  test('发布竞态对照：闭包完整时探针退出码为 0，不报等待', async () => {
    const { status, out } = await runProbe('rc2');
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /闭包尚未发布完整/);
    assert.match(out, /探针通过/);
  });

  // #28 的落点：把「模型预测的树」与真实 npm 装出来的树逐包对账。
  // 基线来自 2026-09-29 那次真实发布的 upstream-versions-windows-x64.json。
  // 结构必须完全一致；版本只允许 libreoffice-kit 一处不同（fixture 录于 09-30，
  // 而 0.1.3 是发布之后才出现的，^0.1.1 两边都满足）——多出任何一处就说明模型偏了。
  test('与真实 npm 安装树逐包对账：结构零差异，版本零意外', async () => {
    const npmTree = JSON.parse(readFileSync(join(HERE, 'fixtures', 'tree-0.2.0-rc.2-npm.json'), 'utf8'));
    const { status, dir } = await runPin('rc2');
    assert.equal(status, 0);
    const model = JSON.parse(readFileSync(join(dir, 'upstream-versions.json'), 'utf8'));

    assert.equal(npmTree.tag, model.tag);
    assert.deepEqual(Object.keys(model.pinned).sort(), Object.keys(npmTree.pinned).sort(),
      '同版本线包集合必须与真实安装一致');
    assert.deepEqual(Object.keys(model.independent).sort(), Object.keys(npmTree.independent).sort(),
      '独立版本线包集合必须与真实安装一致');

    // 同版本线全部锁在 tag 精确版本，两边都该如此
    for (const [name, version] of Object.entries(npmTree.pinned)) {
      assert.equal(version, GRAPHS.rc2.tag, name + ' 真实安装未锁在 tag 版本');
      assert.equal(model.pinned[name], version, name + ' 模型与真实的锁定版本不同');
    }

    const drift = Object.entries(npmTree.independent)
      .filter(([name, version]) => model.independent[name] !== version)
      .map(([name, version]) => name + '（真实 ' + version + '，模型 ' + model.independent[name] + '）');
    assert.deepEqual(drift, ['@deepseek-ai/libreoffice-kit（真实 0.1.2，模型 0.1.3）'],
      '独立线只允许这一处 registry 漂移；新增差异意味着回放模型与 npm 的解析结果分叉');
  });

  test('rc.2 图的回放同样命中 stub registry 而非真实网络', async () => {
    const { registry } = await runPin('rc2');
    assert.ok(registry.hits > 250, '本地 stub 应被大量命中，实际 ' + registry.hits);
  });
});
