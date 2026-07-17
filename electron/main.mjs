import path from "node:path";
import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";
import {
  clearLaunchMode,
  DESKTOP_MODE,
  launchModeFromArgs,
  readLaunchMode,
  shouldResetLaunchMode,
  WEB_MODE,
  writeLaunchMode,
} from "./launchMode.mjs";

const productName = "电商竞品监控";
const isDevelopment = process.argv.includes("--dev");
let mainWindow = null;
let backendServer = null;
let backendUrl = "";
let frontendUrl = "";
let stopBackend = null;
let shutdownStarted = false;
let launchMode = null;
let tray = null;
let modeSwitchActive = false;

app.setName(productName);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (launchMode === WEB_MODE && frontendUrl) {
      shell.openExternal(frontendUrl).catch(() => undefined);
      return;
    }
    if (!frontendUrl) return;
    createWindow(frontendUrl);
  });
}

function launchModePath() {
  return path.join(app.getPath("userData"), "launch-mode.json");
}

function rememberLaunchMode(mode) {
  try {
    writeLaunchMode(launchModePath(), mode);
  } catch (error) {
    dialog.showErrorBox(`${productName}无法保存启动方式`, `本次仍会正常启动，下次会重新询问。\n\n${error.message}`);
  }
}

async function chooseLaunchMode() {
  const result = await dialog.showMessageBox({
    type: "question",
    title: `${productName}启动方式`,
    message: "请选择本次启动方式",
    detail: "桌面 APP 适合独立窗口使用；浏览器网页会在本机启动同一套服务，并用系统默认浏览器打开。",
    buttons: ["桌面 APP", "浏览器网页", "退出"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    checkboxLabel: "记住我的选择，下次直接启动",
    checkboxChecked: false,
  });
  if (result.response === 2) return null;
  const mode = result.response === 1 ? WEB_MODE : DESKTOP_MODE;
  if (result.checkboxChecked) rememberLaunchMode(mode);
  return mode;
}

async function resolveInitialLaunchMode() {
  if (shouldResetLaunchMode(process.argv)) clearLaunchMode(launchModePath());
  const requested = launchModeFromArgs(process.argv);
  if (requested) return requested;
  if (isDevelopment && !process.argv.includes("--choose-launch-mode")) return DESKTOP_MODE;
  return readLaunchMode(launchModePath()) || chooseLaunchMode();
}

function configureRuntimePaths() {
  if (isDevelopment) return;
  const userData = app.getPath("userData");
  process.env.ECOM_MONITOR_DATA_DIR = path.join(userData, "data");
  process.env.ECOM_MONITOR_PROFILE_DIR = path.join(userData, "account-profiles");
  process.env.ECOM_MONITOR_RESOURCE_DIR = app.getAppPath();
  process.env.NODE_ENV = "production";
}

async function startBackend() {
  if (backendServer) return backendUrl;
  configureRuntimePaths();
  const serverModule = await import("../server/index.js");
  const staticDir = isDevelopment ? "" : path.join(app.getAppPath(), "dist");
  backendServer = await serverModule.startServer({
    host: "127.0.0.1",
    port: isDevelopment ? 4317 : 0,
    staticDir,
  });
  stopBackend = serverModule.stopServer;
  const address = backendServer.address();
  const port = typeof address === "object" && address ? address.port : 4317;
  backendUrl = `http://127.0.0.1:${port}`;
  frontendUrl = isDevelopment ? "http://127.0.0.1:5173" : backendUrl;
  return backendUrl;
}

function createWindow(appUrl) {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  const icon = path.join(app.getAppPath(), "public", process.platform === "win32" ? "app-icon.ico" : "app-icon.png");
  mainWindow = new BrowserWindow({
    title: productName,
    width: 1480,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#f6f7f8",
    icon,
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const localOrigin = new URL(appUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(localOrigin)) return { action: "allow" };
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(localOrigin)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => undefined);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(appUrl);
  return mainWindow;
}

function showLaunchError(error) {
  dialog.showErrorBox(`${productName}启动方式切换失败`, error?.message || String(error));
}

async function switchLaunchMode(mode, remember = true) {
  if (modeSwitchActive) return;
  modeSwitchActive = true;
  try {
    if (mode === WEB_MODE) {
      await shell.openExternal(frontendUrl);
    } else {
      createWindow(frontendUrl);
    }
    if (remember) rememberLaunchMode(mode);
    launchMode = mode;
    if (mode === WEB_MODE) mainWindow?.close();
    refreshTray();
  } finally {
    modeSwitchActive = false;
  }
}

function clearRememberedLaunchMode() {
  try {
    clearLaunchMode(launchModePath());
  } catch (error) {
    showLaunchError(error);
    return;
  }
  dialog.showMessageBox({
    type: "info",
    title: productName,
    message: "已清除记住的启动方式",
    detail: "下次启动软件时会重新询问使用桌面 APP 还是浏览器网页。",
    buttons: ["知道了"],
  }).catch(() => undefined);
}

function refreshTray() {
  const icon = path.join(app.getAppPath(), "public", process.platform === "win32" ? "app-icon.ico" : "app-icon.png");
  tray ||= new Tray(icon);
  tray.setToolTip(`${productName} - ${launchMode === WEB_MODE ? "浏览器网页" : "桌面 APP"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: launchMode === WEB_MODE ? "当前：浏览器网页" : "当前：桌面 APP", enabled: false },
    { type: "separator" },
    {
      label: launchMode === WEB_MODE ? "重新打开网页" : "显示桌面窗口",
      click: () => switchLaunchMode(launchMode, false).catch(showLaunchError),
    },
    {
      label: "切换到桌面 APP",
      type: "radio",
      checked: launchMode === DESKTOP_MODE,
      click: () => switchLaunchMode(DESKTOP_MODE).catch(showLaunchError),
    },
    {
      label: "切换到浏览器网页",
      type: "radio",
      checked: launchMode === WEB_MODE,
      click: () => switchLaunchMode(WEB_MODE).catch(showLaunchError),
    },
    { type: "separator" },
    { label: "下次启动时重新选择", click: clearRememberedLaunchMode },
    { label: "退出", click: () => shutdown().catch(() => app.exit(1)) },
  ]));
  tray.removeAllListeners("double-click");
  tray.on("double-click", () => switchLaunchMode(launchMode, false).catch(showLaunchError));
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    tray?.destroy();
    tray = null;
    if (stopBackend && backendServer) await stopBackend(backendServer);
  } finally {
    app.quit();
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  try {
    launchMode = await resolveInitialLaunchMode();
    if (!launchMode) {
      app.quit();
      return;
    }
    await startBackend();
    refreshTray();
    if (launchMode === WEB_MODE) await shell.openExternal(frontendUrl);
    else createWindow(frontendUrl);
  } catch (error) {
    dialog.showErrorBox(`${productName}启动失败`, error?.stack || error?.message || String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (launchMode === WEB_MODE) return;
  shutdown().catch(() => app.quit());
});

app.on("activate", () => {
  if (!frontendUrl) return;
  if (launchMode === WEB_MODE) shell.openExternal(frontendUrl).catch(() => undefined);
  else createWindow(frontendUrl);
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !backendServer) return;
  event.preventDefault();
  shutdown().catch(() => app.exit(1));
});
