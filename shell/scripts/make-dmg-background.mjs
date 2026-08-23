// 由 dmg-background.svg 渲染 dmg 窗口背景（680x480 与 2x 视网膜版）。
// 用法: node scripts/make-dmg-background.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const svg = readFileSync(new URL('../build/dmg-background.svg', import.meta.url));
const base = fileURLToPath(new URL('../build/', import.meta.url));
await sharp(svg, { density: 144 }).png().toFile(base + 'background@2x.png');
await sharp(svg, { density: 144 }).resize(680, 480).png().toFile(base + 'background.png');
console.log('dmg background written');
