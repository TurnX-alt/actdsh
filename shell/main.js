// actdsh 桌面壳主进程。
// 职责仅限：以内嵌 Node 拉起上游 dsh web，等待就绪后在窗口中加载 GUI。
// 不向上游传递任何未证实的参数，不添加任何新功能。
const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const GUI_ORIGIN = 'http://127.0.0.1:3080';
const READY_TIMEOUT_MS = 60000;

let dshChild = null;
let mainWindow = null;

// 单实例：避免第二次启动时端口冲突。
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function resolveDshBin() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh')
    : path.join(__dirname, 'runtime');
  return path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function startDsh() {
  // 复用 Electron 内嵌的 Node 运行时（ELECTRON_RUN_AS_NODE），不单独分发 Node。
  dshChild = spawn(process.execPath, [resolveDshBin(), 'web'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dshChild.stdout.on('data', (chunk) => console.log('[dsh]', chunk.toString().trimEnd()));
  dshChild.stderr.on('data', (chunk) => console.error('[dsh]', chunk.toString().trimEnd()));
  dshChild.on('exit', (code) => {
    if (!app.isQuitting) {
      dialog.showErrorBox('dsh 服务已退出', '后台 dsh 进程异常退出（退出码 ' + code + '）。应用将关闭。');
      app.quit();
    }
  });
}

function waitReady(deadline) {
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(GUI_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('等待 dsh 服务就绪超时（' + GUI_ORIGIN + '）。请确认 3080 端口未被占用。'));
        } else {
          setTimeout(probe, 500);
        }
      });
      req.setTimeout(1000, () => req.destroy(new Error('probe timeout')));
    };
    probe();
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'actdsh',
    autoHideMenuBar: true,
  });
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center">' +
    '<p>正在启动 dsh 服务…</p></body>'));
  await waitReady(Date.now() + READY_TIMEOUT_MS);
  await mainWindow.loadURL(GUI_ORIGIN);
}

app.whenReady().then(async () => {
  startDsh();
  try {
    await createMainWindow();
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err && err.message ? err.message : err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (dshChild && !dshChild.killed) {
    dshChild.kill();
  }
});
