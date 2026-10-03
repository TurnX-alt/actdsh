// 实时 registry 探针：在发布流水线之外，提前发现会让版本线钉死失败的上游变化。
//
// 为什么需要它：离线 fixture 回放（shell/scripts/lib/pin-replay.test.mjs）保证判定逻辑
// 正确，但对上游发版是盲的。2026-09-23 的发布失败正是由 registry 的真实变化触发
// （libreoffice-kit 26 小时内连发 0.0.3 / 0.0.4 / 0.1.0），而钉死脚本只在发布路径上跑，
// 于是第一个发现问题的时机就是发布失败本身。
//
// 探针只做 BFS + 选版，不装包；只有在显式给出 DSH_WAITING_OUT 时才写那一个等待状态文件。
// 因此可以每天跑。
// 会硬失败的三种情况：
//   1. 出现未支持的版本区间形态（>=、||、workspace: 等）——satisfiesRange 会抛
//   2. 某个独立版本线包没有任何已发布版本能同时满足全部声明区间
//   3. npm 上不存在该 tag 的 @deepseek-ai/dsh
// 另外会给出一条预警：独立线包的声明区间已不再容纳 npm 最新稳定版。这正是当年
// 触发事故的条件；采纳 ADR 0001 后已能正确处理，但它是上游版本线开始分叉的信号。
//
// 用法: node shell/scripts/probe-upstream.mjs [tag-version]
//       省略 tag 时取上游最新 release。
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findUnpublishedFamilyMembers,
  highestSatisfying,
  latestStable,
  newestReplayBaseline,
  resolveIndependentVersions,
  walkFamilyClosure,
} from './lib/version-line.mjs';

const REGISTRY = (process.env.DSH_PIN_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
// 与 DSH_PIN_REGISTRY / DSH_PIN_NPM 同一约定：基线目录也可注入，好让「基线落后」这条
// 分支有真实子进程的端到端证据，而不是只停在纯函数单测上。
const FIXTURE_DIR = (process.env.DSH_PIN_FIXTURE_DIR ?? fileURLToPath(new URL('./lib/fixtures/', import.meta.url))).replace(/[/\\]+$/, '') + '/';
const BASELINE_DIR = process.env.DSH_PIN_FIXTURE_DIR ?? FIXTURE_DIR;
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

// 上游的 npm 家族分批发布，成员包可以比根包晚 20 分钟以上（实测 rc.1：12:34:03 → 12:54:22）。
// 这种缺口等一轮就好，与「区间形态不认识 / 永远无解」不是一类问题，因此给出独立退出码 3，
// 让发布流水线在本轮空转退出而不是炸一次构建。
const waiting = findUnpublishedFamilyMembers(publishedByPackage, edges, V);
if (!pinnable.has(ROOT_PACKAGE)) {
  waiting.unshift({ name: ROOT_PACKAGE, latest: (publishedByPackage.get(ROOT_PACKAGE) ?? []).at(-1) ?? '(无)' });
}
if (waiting.length > 0) {
  console.log('闭包尚未发布完整（等待上游发布窗口关闭，本轮不可打包）：');
  for (const item of waiting) console.log('  缺 ' + V + '：' + item.name + '（最新 ' + item.latest + '）');
  console.log('::warning::' + waiting.length + ' 个家族包还没发布 ' + V + '，退出码 3 表示「等一轮」。');
  // 机器可读的等待状态，#41 靠它跨 run 计数。与通道快照同一套做法：stdout 是给人看的，
  // 判定要用结构化数据——从「N 个家族包还没发布」这种散文里 grep 数字，改天换措辞就静默失效。
  if (process.env.DSH_WAITING_OUT !== undefined && process.env.DSH_WAITING_OUT !== '') {
    writeFileSync(process.env.DSH_WAITING_OUT, JSON.stringify({
      schemaVersion: 1,
      tag: V,
      missingCount: waiting.length,
      missing: waiting.map((item) => item.name),
      checkedAt: new Date().toISOString(),
    }, null, 1) + '\n');
  }
  // 用 exitCode 而非 exit()：脚本留着未关闭的 fetch 连接，Windows 上 exit() 会在 libuv
  // 断言处崩溃，把退出码变成 0xC0000409——调用方分支于退出码，崩溃会让判定失真。
  process.exitCode = 3;
} else {
  let independent;
  try {
    independent = resolveIndependentVersions(publishedByPackage, edges);
  } catch (error) {
    console.error('::error::独立版本线选版失败：' + error.message);
    process.exitCode = 1;
  }

  if (independent !== undefined) {
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

    // 回放基线的落后检测（#30 的触发点）。探针每天本来就在算实时闭包，比一下基线文件名
    // 里的 tag 就知道离线套件在测哪一年的图；读的是文件名，不解析大 JSON。
    const baseline = newestReplayBaseline(readdirSync(FIXTURE_DIR), V);
    if (baseline.lagging) {
      console.log('::warning::回放基线落后：最新 fixture 是 '
        + (baseline.newest ?? '（无）') + '，实时 tag 是 ' + V
        + '。按发布同刻追加录制（不得就地覆盖）：node shell/scripts/lib/record-pin-fixture.mjs '
        + V + ' shell/scripts/lib/fixtures/pin-' + V + '.json');
    }
    console.log('探针通过：BFS 与选版在实时 registry 上均可完成。');
  }
}
