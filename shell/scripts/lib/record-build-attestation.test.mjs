// 构建环境留证的组装逻辑。放在 lib/ 下是因为 CI 的测试门槛只吃 shell/scripts/lib/**/*.test.mjs。
//
// 这份留证是给别人核对构建过程用的，所以它最坏的失效不是算错哈希，而是「看起来完整、
// 其实少了字段或悄悄替占位值做了主」。下面的负控制针对的正是这两条。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAttestation } from '../record-build-attestation.mjs';

const dir = mkdtempSync(join(tmpdir(), 'actdsh-attest-'));
const lockfile = join(dir, 'pnpm-lock.yaml');
const artifact = join(dir, 'deepseek-harness-0.1.7-rc.2-win-x64-unsigned.exe');
writeFileSync(lockfile, 'lockfile-content\n');
writeFileSync(artifact, Buffer.alloc(1024, 7));

const base = {
  UPSTREAM_REPO: 'deepseek-ai/deepseek-harness',
  UPSTREAM_TAG: 'dsh-v0.1.7-rc.2',
  UPSTREAM_COMMIT: '477b4f42',
  LOCKFILE_PATH: lockfile,
  ARTIFACT_PATH: artifact,
  NODE_VERSION: 'v24.18.0',
  PNPM_VERSION: '10.14.0',
  RUNNER_IMAGE: 'windows-2025',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: '{"allowedAuthOrigins":["https://login.example.com"]}',
  COMMAND_SEQUENCE: 'pnpm install --frozen-lockfile\npnpm --dir native/system run build:ts\npnpm package:desktop:win:x64:unsigned',
};

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('输入齐全时产出完整留证，主张边界写进数据而不是只写在注释里', () => {
  const record = buildAttestation(base, '2026-09-26T00:00:00.000Z');
  assert.equal(record.claim, 'independent-build-reference');
  assert.equal(record.notClaim, 'reproducible-build');
  assert.equal(record.recordedAt, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(record.upstream, {
    repository: 'deepseek-ai/deepseek-harness',
    tag: 'dsh-v0.1.7-rc.2',
    commit: '477b4f42',
  });
  assert.deepEqual(record.toolchain, { node: 'v24.18.0', pnpm: '10.14.0', runnerImage: 'windows-2025' });
  assert.equal(record.commands.length, 3);
  assert.equal(record.commands[2], 'pnpm package:desktop:win:x64:unsigned');
  assert.match(record.inputs.lockfileSha256, /^[0-9a-f]{64}$/);
  assert.match(record.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.artifact.sizeBytes, 1024);
  assert.equal(record.artifact.signed, false);
  assert.equal(record.artifact.notarized, false);
});

test('lockfile 与产物的哈希各自独立算，不留两份相同值蒙混', () => {
  const record = buildAttestation(base, '2026-09-26T00:00:00.000Z');
  assert.notEqual(record.artifact.sha256, record.inputs.lockfileSha256);
});

test('缺任一必需输入就抛错并点名，不产出半份看起来完整的留证', () => {
  for (const name of ['UPSTREAM_REPO', 'UPSTREAM_TAG', 'UPSTREAM_COMMIT', 'LOCKFILE_PATH', 'ARTIFACT_PATH']) {
    const broken = { ...base };
    delete broken[name];
    assert.throws(() => buildAttestation(broken, 'x'), new RegExp(name), name + ' 缺失必须报错');
  }
  assert.throws(() => buildAttestation({ ...base, UPSTREAM_TAG: '' }, 'x'), /UPSTREAM_TAG/,
    '空字符串等同于缺失');
});

test('占位 origin 原样进留证并带警示备注（不能被"修正"成真实地址）', () => {
  const record = buildAttestation(base, '2026-09-26T00:00:00.000Z');
  assert.equal(record.inputs.placeholderOrigins.mandatoryUpdateTestOrigin, 'https://test.example.com');
  assert.equal(record.inputs.placeholderOrigins.allowedAuthOrigins, '{"allowedAuthOrigins":["https://login.example.com"]}');
  assert.match(record.inputs.placeholderOrigins.note, /不可作为对外发布的发行版/);
});

test('留证记仓库内相对路径，不把本机临时目录写进本该可核对的记录', () => {
  const record = buildAttestation({ ...base, REPO_ROOT: dir }, '2026-09-26T00:00:00.000Z');
  assert.equal(record.inputs.lockfile, 'pnpm-lock.yaml');
  assert.equal(record.artifact.path, 'deepseek-harness-0.1.7-rc.2-win-x64-unsigned.exe');
  assert.doesNotMatch(record.inputs.lockfile + record.artifact.path, /Temp|Users|actdsh-attest/,
    '绝对路径一旦进留证，记录就只能在生成它的那台机器上读');
});

test('REPO_ROOT 缺省时退回原值，不猜相对路径', () => {
  const record = buildAttestation(base, '2026-09-26T00:00:00.000Z');
  assert.equal(record.inputs.lockfile, lockfile.replaceAll('\\', '/'));
});

test('未提供可选工具链字段时记为 unknown，而不是省略字段', () => {
  const record = buildAttestation({
    UPSTREAM_REPO: base.UPSTREAM_REPO,
    UPSTREAM_TAG: base.UPSTREAM_TAG,
    UPSTREAM_COMMIT: base.UPSTREAM_COMMIT,
    LOCKFILE_PATH: base.LOCKFILE_PATH,
    ARTIFACT_PATH: base.ARTIFACT_PATH,
  }, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(record.toolchain, { node: 'unknown', pnpm: 'unknown', runnerImage: 'unknown' });
  assert.deepEqual(record.commands, []);
});
