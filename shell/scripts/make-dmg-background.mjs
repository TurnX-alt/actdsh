// 由 dmg-background.svg 渲染 dmg 窗口背景（单分辨率 680×480 PNG）。
// 可选参数: node scripts/make-dmg-background.mjs [input.svg] [outputDir]
// SVG 中若包含 <!-- ORCA_PATH --> 占位注释，脚本会把 shell/build/favicon.svg 的 path 内联进去
// （与 build/icon.png 同源，保证背景与图标观感统一）；favicon 缺失时占位留空、不影响渲染。
// 注意：只输出单分辨率 PNG，不产出 @2x 兄弟文件 —— electron-builder 检测到 @2x 会把背景合并为
// 多分辨率 TIFF，而 Finder 26.2+/27 会把该 TIFF 的全分辨率当作窗口尺寸（实测窗口被放大到
// 1360×960 点、图标随缩放错位、底部文件标签被窗口下缘裁切）。
import { readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const buildDir = fileURLToPath(new URL('../build/', import.meta.url));
const [, , inputArg, outDirArg] = process.argv;
const input = inputArg ?? buildDir + 'dmg-background.svg';
const outDir = outDirArg ?? buildDir;

let svg = readFileSync(input, 'utf8');
if (svg.includes('<!-- ORCA_PATH -->')) {
  let orca = '';
  try {
    const favicon = readFileSync(buildDir + 'favicon.svg', 'utf8');
    const m = favicon.match(/<path[^>]*\bd="([^"]+)"/);
    if (m) orca = `<path d="${m[1]}"/>`;
  } catch {}
  svg = svg.replace('<!-- ORCA_PATH -->', orca);
}

mkdirSync(outDir, { recursive: true });
const stem = basename(input).replace(/\.svg$/i, '');
const outName = stem === 'dmg-background' ? 'background' : stem;
// 输出尺寸取自 SVG viewBox 逻辑尺寸（如 680×513），保证背景与窗口/内容区精确对应。
let logW = 680, logH = 480;
const vm = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
if (vm) { logW = Math.round(parseFloat(vm[1])); logH = Math.round(parseFloat(vm[2])); }
await sharp(Buffer.from(svg), { density: 144 }).resize(logW, logH).png().toFile(`${outDir}/${outName}.png`);
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(`${outDir}/${outName}@2x.png`);
console.log(`dmg background written: ${outDir}${outName}.png (${logW}x${logH}) + @2x (${logW * 2}x${logH * 2})`);