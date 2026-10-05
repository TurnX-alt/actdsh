// 两条检出步骤的顺序不变量。
//
// 为什么用字符串位置而不是解析 YAML：本仓库的运行时零依赖，为一条断言引入 js-yaml 不值。
// 这条不变量今天在真实 runner 上被违反过两次——先把 actdsh 检出到 actdsh-tools/、再让上游检出
// 清空工作区根目录，等于把留证脚本自己删掉（run 37213411223：Cannot find module
// ...actdsh-tools/shell/scripts/record-build-attestation.mjs）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const WORKFLOW = fileURLToPath(new URL(
  '../../../.github/workflows/build-official-desktop.yml', import.meta.url));

test('官方源码检出之后才能检出本仓库，否则留证脚本会被清空', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const upstream = text.indexOf('repository: deepseek-ai/deepseek-harness');
  const tools = text.indexOf('path: actdsh-tools');
  assert.ok(upstream > 0, '两条检出步骤都该在文件里');
  assert.ok(tools > 0, '两条检出步骤都该在文件里');
  assert.ok(tools > upstream, 'actdsh-tools 的检出必须排在上游检出之后');
});

test('留证线只由 workflow_dispatch 触发，push 触发不该回来', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('jobs:'));
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /^\s{2}push:/m,
    '这条线一次构建要 120 分钟，挂在 push 上等于每次改文件就白烧一次');
});
