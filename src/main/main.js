'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const { startProxy } = require('./proxy');
const { listVoices } = require('./voices');

app.disableHardwareAcceleration();

// 必须用独立数据目录：绝不能和网页版客户端共用 %APPDATA%\DeepSeek，
// 否则会覆盖网页版的登录态
app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeekPublic'));

// 打包后启动异常时用这个文件定位（临时诊断）
try {
  fs.appendFileSync(path.join(require('os').tmpdir(), 'ds-boot.log'), new Date().toISOString() + ' module loaded\n');
} catch (e) {}

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'renderer');
const ASSETS = path.join(ROOT, 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json'
};

let mainWindow = null;
let tray = null;
let server = null;
let appUrl = '';
const PROXY_PORT = 8788;
// 固定端口 = 固定 origin，保证对话记录始终落在同一个库里
const APP_PORT = 54687;
// 桌宠宿主半边（dsh-pet 插件的服务端）
const PET_PORT = 3081;
// 桌宠包：安装包里自带的优先（打包后在 resources/pet，开发时在 vendor/dsh-pet），
// 都没有才回落到本机 DSH 的插件目录
const PET_PKG = (() => {
  const candidates = [
    path.join(process.resourcesPath || '', 'pet'),
    path.join(ROOT, 'vendor', 'dsh-pet')
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'lib', 'standalone.js'))) return dir;
  }
  return path.join(app.getPath('home'), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet');
})();
const PET_HOME = path.join(app.getPath('appData'), 'DeepSeekPublic', 'pet-home');
let configFile = '';
let petChild = null;
let petLog = null;

/* 启动 dsh-pet 的宿主半边（插件自己的服务端），display=web 不拉桌面小窗 */
function startPetHost() {
  try {
    const cfgDir = path.join(PET_HOME, 'dsh-pet');
    fs.mkdirSync(cfgDir, { recursive: true });

    // 用用户自己的配置，只把 display 改成 web（否则它会去拉 Electron 43 的桌面小窗，必崩）
    const userCfg = path.join(app.getPath('home'), '.dsh', 'dsh-pet', 'main-config.jsonc');
    if (fs.existsSync(userCfg)) {
      const text = fs.readFileSync(userCfg, 'utf8').replace(/"display"\s*:\s*"(both|desktop)"/g, '"display": "web"');
      fs.writeFileSync(path.join(cfgDir, 'main-config.jsonc'), text, 'utf8');
    }

    const petLogPath = path.join(PET_HOME, 'host.log');
    petLog = fs.openSync(petLogPath, 'a');

    const entry = path.join(PET_PKG, 'lib', 'standalone.js');
    if (!fs.existsSync(entry)) return;

    petChild = spawn(process.execPath, [entry, '--port', String(PET_PORT)], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: PET_HOME,
        DSH_PET_ELECTRON_PATH: process.execPath
      },
      stdio: ['ignore', petLog, petLog],
      windowsHide: true
    });
  } catch (e) { /* 桌宠起不来不影响聊天 */ }
}

/* 本地静态服务：给页面一个正常的 origin，避免 file:// 的跨域限制 */
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';

      // 桌宠路由交给插件自己的服务端
      if (rel.startsWith('/dsh-pet-7340')) {
        // 宿主要求 Host/Origin 必须是它自己的回环地址，这里改写成 :PET_PORT
        const fwd = Object.assign({}, req.headers, {
          host: '127.0.0.1:' + PET_PORT,
          origin: 'http://127.0.0.1:' + PET_PORT,
          referer: 'http://127.0.0.1:' + PET_PORT + '/'
        });
        // 宿主是异步启动的，页面可能比它先就绪：连不上就重试几次
        let attempt = 0;
        const forward = () => {
          const up = http.request(
            { hostname: '127.0.0.1', port: PET_PORT, path: req.url, method: req.method, headers: fwd },
            (upRes) => {
              res.writeHead(upRes.statusCode || 502, upRes.headers);
              upRes.pipe(res);
            }
          );
          up.on('error', () => {
            attempt += 1;
            if (attempt <= 10) {
              setTimeout(forward, 400);
              return;
            }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('pet host not ready');
          });
          req.pipe(up);
        };
        forward();
        return;
      }

      const file = path.join(WEB, rel.replace(/^\/+/, ''));
      if (!file.startsWith(WEB)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }

      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });

    // 端口必须固定：localStorage / IndexedDB 按 origin 隔离，
    // 每次随机端口会让之前所有对话「消失」（其实是换了新库）
    let attempt = 0;
    const listen = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 6) {
          attempt += 1;
          setTimeout(listen, 600); // 上一个实例可能还没完全退出
          return;
        }
        reject(e);
      });
      server.listen(APP_PORT, '127.0.0.1', () => {
        // 用根路径而不是 /index.html：桌宠插件按 document.baseURI 推导路由前缀，
        // 带文件名会算成 /index.html/dsh-pet-7340，路由就 404 了
        appUrl = `http://127.0.0.1:${APP_PORT}/`;
        resolve(appUrl);
      });
    };
    listen();
  });
}

function createWindow(show) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DeepSeek',
    backgroundColor: '#ffffff',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(appUrl);

  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let img = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? 'tray-mac.png' : 'tray.png'));
  if (!img.isEmpty() && !IS_MAC) img = img.resize({ width: 16, height: 16 });
  if (!img.isEmpty() && IS_MAC) img.setTemplateImage(true);

  tray = new Tray(img);
  tray.setToolTip('DeepSeek');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showWindow },
    { type: 'separator' },
    {
      label: '模型配置文件',
      click: () => { if (configFile) shell.openPath(configFile); }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
  if (!IS_MAC) tray.on('click', showWindow);
}

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.whenReady().then(async () => {
    const logDir = app.getPath('userData');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
    const logFile = path.join(logDir, 'boot.log');
    const log = (m) => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} };
    log('start');
    configFile = path.join(app.getPath('userData'), 'config.json');
    try {
      await startProxy(PROXY_PORT, configFile);
      log('proxy ok ' + PROXY_PORT);
    } catch (e) {
      log('proxy fail ' + e.message);
    }

    startPetHost();
    await startServer();
    log('server ok ' + appUrl);
    createWindow(true);
    log('window created');

    // 代码块「预览」：把 HTML 写到临时文件再用独立窗口打开
    ipcMain.on('preview:html', (e, html) => {
      try {
        const file = path.join(os.tmpdir(), 'ds-preview-' + Date.now() + '.html');
        fs.writeFileSync(file, String(html), 'utf8');
        const w = new BrowserWindow({
          width: 960,
          height: 720,
          title: '预览',
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
        });
        w.loadFile(file);
      } catch (err) { /* ignore */ }
    });
    // 服务商设置：前端保存后写进 config.json，转换层每次请求前重新读
    ipcMain.handle('provider:save', (e, payload) => {
      try {
        const next = {
          baseUrl: String((payload && payload.baseUrl) || '').trim(),
          apiKey: String((payload && payload.apiKey) || ''),
          model: String((payload && payload.model) || '').trim(),
          historyChars: Number(payload && payload.historyChars) || 12000
        };
        fs.writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf8');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('provider:get', () => {
      try {
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
      } catch (e) {
        return {};
      }
    });

    // 系统语音列表（Windows 语音合成音色）
    ipcMain.handle('voices:list', () => listVoices());

    createTray();    try {
      globalShortcut.register('Alt+F', showWindow);
    } catch (e) { /* ignore */ }

    app.on('activate', showWindow);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (server) server.close();
});
