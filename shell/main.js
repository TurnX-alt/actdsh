// actdsh 桌面壳主进程。
// 职责仅限：以内嵌 Node 拉起上游 dsh web，等待官方就绪信号后在窗口中加载 GUI。
// 面向零环境用户：自带 Node（ELECTRON_RUN_AS_NODE）与 pnpm 垫片，端口自动回退，
// 不向上游传递任何未证实的参数，不添加任何新功能。
const { app, BrowserWindow, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// dsh 官方默认端口为 3080；被打包版用户可能残留冲突进程，故依次回退 3081-3099，最后交给 OS 分配（0）。
const PORT_CANDIDATES = [];
for (let p = 3080; p <= 3099; p += 1) PORT_CANDIDATES.push(p);
const READY_TIMEOUT_MS = 180000; // 首启含 profile 初始化与安全软件扫描，慢机留足余量
// 官方就绪信号：stdout 打印 "dsh web: http://127.0.0.1:<port>"。
const URL_PATTERN = /dsh web: (https?:\/\/\S+)/;

let dshChild = null;
let mainWindow = null;
let logStream = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function resourcesBase() {
  // extraResources 以 from=项目根、filter=runtime/** 拷入：打包内实际落点为 resources/dsh/runtime/。
  // （electron-builder 硬性排除任何拷贝源的根级 node_modules，故运行时载荷必须嵌套一层。）
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh', 'runtime')
    : path.join(__dirname, 'runtime');
}

function resolveDshBin() {
  return path.join(resourcesBase(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function resolvePnpmCjs() {
  return path.join(resourcesBase(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
}

// dsh 的插件管理（dsh plugin）是 pnpm 的前转器，会 spawnSync('pnpm')。
// 为零环境用户内置 pnpm：在 userData/shims 生成垫片脚本，仅对子进程 PATH 前置注入。
function ensurePnpmShims() {
  const shimDir = path.join(app.getPath('userData'), 'shims');
  fs.mkdirSync(shimDir, { recursive: true });
  const pnpmCjs = resolvePnpmCjs();
  if (process.platform === 'win32') {
    // spawnSync(..., { shell: true }) 经 cmd 解析，.cmd 垫片可被命中。
    fs.writeFileSync(path.join(shimDir, 'pnpm.cmd'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' + process.execPath + '" "' + pnpmCjs + '" %*\r\n');
  } else {
    const shim = path.join(shimDir, 'pnpm');
    fs.writeFileSync(shim,
      '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "' + process.execPath + '" "' + pnpmCjs + '" "$@"\n');
    fs.chmodSync(shim, 0o755);
  }
  return shimDir;
}

function probeFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickPort() {
  for (const port of PORT_CANDIDATES) {
    if (await probeFree(port)) return port;
  }
  return 0; // OS 分配；实际端口从官方 URL 就绪行解析。
}

function openLog() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'dsh.log');
  logStream = fs.createWriteStream(logPath, { flags: 'w' });
  return logPath;
}

function startDsh(port, logPath) {
  const shimDir = ensurePnpmShims();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: shimDir + path.delimiter + (process.env.PATH ?? process.env.Path ?? ''),
  };
  dshChild = spawn(process.execPath, [resolveDshBin(), 'web', '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX 下让子进程成为进程组组长，退出时可整组回收（dsh 会再派生沙箱/worker 子进程）。
    detached: process.platform !== 'win32',
  });
  const onChunk = (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    process.stdout.write(text);
  };
  dshChild.stdout.on('data', onChunk);
  dshChild.stderr.on('data', onChunk);
  dshChild.on('error', (err) => {
    if (!app.isQuitting) {
      dialog.showErrorBox('dsh 服务启动失败', String(err && err.message ? err.message : err) + '\n日志：' + logPath);
      app.quit();
    }
  });
  dshChild.on('exit', (code) => {
    if (!app.isQuitting) {
      dialog.showErrorBox('dsh 服务已退出',
        '后台 dsh 进程异常退出（退出码 ' + code + '）。\n日志：' + logPath);
      app.quit();
    }
  });
}

// 退出时整树回收后台 dsh：只杀直接子进程会留下 dsh 自己派生的孙进程（用户实测"关窗后半天清不干净"）。
function killDshTree() {
  if (!dshChild || dshChild.pid === undefined) return;
  const pid = dshChild.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { dshChild.kill(); }
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ } }, 3000);
    }
  } catch { /* 进程已不存在 */ }
}

// 等待官方 URL 就绪行；它是加载窗口的唯一权威依据（端口 0 时尤其如此）。
function waitReadyUrl() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error('等待 dsh 服务就绪超时。\n日志：' + path.join(app.getPath('userData'), 'dsh.log')));
    }, READY_TIMEOUT_MS);
    dshChild.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = URL_PATTERN.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    dshChild.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('dsh 服务在就绪前退出。\n日志：' + path.join(app.getPath('userData'), 'dsh.log')));
    });
  });
}

// 就绪前的加载页：本地文件（便携版运行环境下 data: URL 加载实测不稳定，故不采用）。
function loadingFile() {
  return path.join(__dirname, 'loading.html');
}

app.whenReady().then(async () => {
  // 应用图标与上游 dsh web 的 favicon 同源（构建期由 scripts/make-icon.mjs 生成 icon.png）。
  const iconPath = path.join(__dirname, 'icon.png');
  if (process.platform === 'darwin' && app.dock && fs.existsSync(iconPath)) {
    try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch { /* 图标缺失不阻塞启动 */ }
  }
  const logPath = openLog();
  try {
    const port = await pickPort();
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      title: 'actdsh',
      autoHideMenuBar: true,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
    });
    await mainWindow.loadFile(loadingFile());
    startDsh(port, logPath);
    const url = await waitReadyUrl();
    await mainWindow.loadURL(url);
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err && err.message ? err.message : err));
    app.isQuitting = true;
    if (dshChild && !dshChild.killed) dshChild.kill();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  killDshTree();
  if (logStream) logStream.end();
});
