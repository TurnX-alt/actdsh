// 由上游 dsh web 的 favicon.svg 生成应用图标（1024px PNG，供 electron-builder 自动转换 ico/icns）。
// 用法: node scripts/make-icon.mjs <input.svg> <output.png>
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';

const [, , svgPath, outPath] = process.argv;
if (!svgPath || !outPath) {
  console.error('usage: node scripts/make-icon.mjs <input.svg> <output.png>');
  process.exit(2);
}
const svg = readFileSync(svgPath);
mkdirSync(dirname(outPath), { recursive: true });
// 源 SVG viewBox 为 50x50：density 拉高后再降到 1024，避免位图化模糊。
await sharp(svg, { density: 1500 })
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(outPath);
console.log('icon written: ' + outPath);
