import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";

const productName = "电商竞品监控";
const isDevelopment = process.argv.includes("--dev");
let mainWindow = null;
let backendServer = null;
let stopBackend = null;
let shutdownStarted = false;

app.setName(productName);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
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
  return `http://127.0.0.1:${port}`;
}

function createWindow(appUrl) {
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
  mainWindow.loadURL(isDevelopment ? "http://127.0.0.1:5173" : appUrl);
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    if (stopBackend && backendServer) await stopBackend(backendServer);
  } finally {
    app.quit();
  }
}

app.whenReady().then(async () => {
  try {
    const appUrl = await startBackend();
    createWindow(appUrl);
  } catch (error) {
    dialog.showErrorBox(`${productName}启动失败`, error?.stack || error?.message || String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  shutdown().catch(() => app.quit());
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !backendServer) return;
  event.preventDefault();
  shutdown().catch(() => app.exit(1));
});
