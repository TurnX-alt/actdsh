// 实时 registry 探针：在发布流水线之外，提前发现会让版本线钉死失败的上游变化。
//
// 为什么需要它：离线 fixture 回放（shell/scripts/lib/pin-replay.test.mjs）保证判定逻辑
// 正确，但对上游发版是盲的。2026-09-23 的发布失败正是由 registry 的真实变化触发
// （libreoffice-kit 26 小时内连发 0.0.3 / 0.0.4 / 0.1.0），而钉死脚本只在发布路径上跑，
// 于是第一个发现问题的时机就是发布失败本身。
//
// 探针只做 BFS + 选版，不装包、不写文件，因此可以每天跑。
// 会硬失败的三种情况：
//   1. 出现未支持的版本区间形态（>=、||、workspace: 等）——satisfiesRange 会抛
//   2. 某个独立版本线包没有任何已发布版本能同时满足全部声明区间
//   3. npm 上不存在该 tag 的 @deepseek-ai/dsh
// 另外会给出一条预警：独立线包的声明区间已不再容纳 npm 最新稳定版。这正是当年
// 触发事故的条件；采纳 ADR 0001 后已能正确处理，但它是上游版本线开始分叉的信号。
//
// 用法: node shell/scripts/probe-upstream.mjs [tag-version]
//       省略 tag 时取上游最新 release。
import {
  highestSatisfying,
  latestStable,
  resolveIndependentVersions,
  walkFamilyClosure,
} from './lib/version-line.mjs';

const REGISTRY = (process.env.DSH_PIN_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
const ROOT_PACKAGE = '@deepseek-ai/dsh';
const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';
const POOL = 12;

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res.json();
}

async function packument(name) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getJson(REGISTRY + '/' + name.replace('/', '%2f'), {
        accept: 'application/vnd.npm.install-v1+json',
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('packument failed for ' + name);
}

async function resolveTag() {
  const arg = process.argv[2];
  if (arg !== undefined && arg !== '') return arg.replace(/^dsh-v/, '');
  const headers = process.env.GITHUB_TOKEN === undefined
    ? {}
    : { authorization: 'Bearer ' + process.env.GITHUB_TOKEN };
  const releases = await getJson('https://api.github.com/repos/' + UPSTREAM_REPO + '/releases?per_page=20', headers);
  const tag = releases.find((r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('dsh-v'))?.tag_name;
  if (tag === undefined) throw new Error('上游没有 dsh-v* release');
  return tag.replace(/^dsh-v/, '');
}

const V = await resolveTag();
console.log('探针目标 tag: ' + V);

const { pinnable, publishedByPackage, edges } = await walkFamilyClosure(ROOT_PACKAGE, V, packument, { pool: POOL });
if (!pinnable.has(ROOT_PACKAGE)) {
  console.error('::error::npm 注册表不存在 ' + ROOT_PACKAGE + '@' + V + '：上游该 release 未发布 npm 包。');
  process.exit(1);
}

let independent;
try {
  independent = resolveIndependentVersions(publishedByPackage, edges);
} catch (error) {
  console.error('::error::独立版本线选版失败：' + error.message);
  process.exit(1);
}

console.log('同版本线 ' + pinnable.size + ' 个；独立版本线 ' + independent.size + ' 个');

// 预警：声明区间已不再容纳 npm 最新稳定版。
const diverged = [];
for (const [name, info] of [...independent.entries()].sort()) {
  const newest = latestStable(publishedByPackage.get(name));
  const admitsNewest = highestSatisfying([newest], info.ranges) !== undefined;
  console.log('  ' + name + ' -> ' + info.version
    + '  ranges=' + JSON.stringify(info.ranges)
    + '  declared=' + info.declared
    + '  npm最新稳定版=' + newest + (admitsNewest ? '' : '（不被声明区间容纳）'));
  if (!admitsNewest) diverged.push(name + '（声明 ' + info.ranges.join('、') + '，npm 最新 ' + newest + '）');
}

if (diverged.length > 0) {
  console.log('::warning::独立版本线已与 npm 最新版分叉，钉死将跟随上游声明而非最新版: ' + diverged.join('; '));
}
console.log('探针通过：BFS 与选版在实时 registry 上均可完成。');
