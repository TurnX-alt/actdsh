// 把一次官方源码构建的输入与产物指纹整理成一份可核对的留证文件。
//
// 为什么不是「可复现构建证明」：Electron + pnpm 工具链不保证字节一致（下载时点、file key、
// 时间戳都会进产物），我们自己从同一个 tag 重算出的哈希与官方不同，推不出任何关于篡改的结论。
// 这份留证因此只主张一件事——「在这样这样的输入下，我们产出了这样一个字节序列」，
// 供他人在需要时复核构建过程，而不是证明官方包等于某个源码状态。
//
// 用法: node shell/scripts/record-build-attestation.mjs <out.json>
// 输入全部来自环境变量（见 build-official-desktop.yml 的 step），缺少必需项即失败——
// 一份缺字段的留证看起来仍然像留证，这正是最糟的失效形态。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = ['UPSTREAM_REPO', 'UPSTREAM_TAG', 'UPSTREAM_COMMIT', 'LOCKFILE_PATH', 'ARTIFACT_PATH'];

export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// 留证要能被别人对照，因此记仓库内相对路径而不是本机绝对路径——CI 里后者是 runner 的临时目录，
// 既无信息量又每次不同。不在 REPO_ROOT 之下时退回原值，不猜。
export function displayPath(path, repoRoot) {
  const normalized = String(path).replaceAll('\\', '/');
  const root = typeof repoRoot === 'string' && repoRoot !== ''
    ? repoRoot.replaceAll('\\', '/').replace(/\/+$/, '')
    : '';
  if (root !== '' && normalized.startsWith(root + '/')) return normalized.slice(root.length + 1);
  return normalized;
}

/** 组装留证对象。secrets 之外的字段一律保留，空字符串视为缺失。 */
export function buildAttestation(env, now) {
  const missing = REQUIRED.filter((name) => typeof env[name] !== 'string' || env[name] === '');
  if (missing.length > 0) throw new Error('留证缺少必需输入: ' + missing.join('、'));

  const artifact = env.ARTIFACT_PATH;
  return {
    schemaVersion: 1,
    // 主张的边界写死在数据里，而不是只写在注释里：读这份文件的人不需要先去读 workflow。
    claim: 'independent-build-reference',
    notClaim: 'reproducible-build',
    recordedAt: now,
    upstream: {
      repository: env.UPSTREAM_REPO,
      tag: env.UPSTREAM_TAG,
      commit: env.UPSTREAM_COMMIT,
    },
    toolchain: {
      node: env.NODE_VERSION ?? 'unknown',
      pnpm: env.PNPM_VERSION ?? 'unknown',
      runnerImage: env.RUNNER_IMAGE ?? 'unknown',
    },
    inputs: {
      lockfile: displayPath(env.LOCKFILE_PATH, env.REPO_ROOT),
      lockfileSha256: sha256OfFile(env.LOCKFILE_PATH),
      // 打包用的两个 origin 是上游 .env.windows.example 里的占位值，不是真实服务地址。
      // 因此本产物不是可对外发布的发行版，这一条必须出现在留证里而不是只在 workflow 注释里。
      placeholderOrigins: {
        mandatoryUpdateTestOrigin: env.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN ?? '',
        allowedAuthOrigins: env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG ?? '',
        note: '上游文档化占位值；该产物不可作为对外发布的发行版',
      },
    },
    commands: (env.COMMAND_SEQUENCE ?? '').split('\n').filter((line) => line !== ''),
    artifact: {
      path: displayPath(artifact, env.REPO_ROOT),
      sha256: sha256OfFile(artifact),
      sizeBytes: readFileSync(artifact).byteLength,
      signed: false,
      notarized: false,
    },
  };
}

// 直接被执行时才跑；被测试 import 时只提供上面两个函数。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = process.argv[2];
  if (out === undefined) {
    console.error('usage: node shell/scripts/record-build-attestation.mjs <out.json>');
    process.exitCode = 2;
  } else {
    try {
      const attestation = buildAttestation(process.env, new Date().toISOString());
      writeFileSync(out, JSON.stringify(attestation, null, 2) + '\n');
      console.log('留证已写入 ' + out + '：' + attestation.artifact.sizeBytes + ' 字节，sha256 '
        + attestation.artifact.sha256.slice(0, 16) + '…');
    } catch (error) {
      console.log('::error::' + error.message);
      process.exitCode = 1;
    }
  }
}
