import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
  desktopCapturer,
} from 'electron';
import path from 'node:path';

const isDev = process.env.NODE_ENV === 'development';

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const startUrl = process.env.ELECTRON_START_URL;
  if (isDev && startUrl) {
    void mainWindow.loadURL(startUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  const rendererEntry = path.join(__dirname, 'renderer', 'index.html');
  void mainWindow.loadFile(rendererEntry);
}

function setupIpc() {
  ipcMain.handle('desktop:ping', () => 'pong');
  ipcMain.handle('desktop:request-media-access', async (_event, kind: 'microphone' | 'camera') => {
    if (process.platform !== 'darwin') {
      return true;
    }

    const mediaType = kind === 'microphone' ? 'microphone' : 'camera';
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    if (status === 'granted') {
      return true;
    }

    return systemPreferences.askForMediaAccess(mediaType);
  });
}

function setupPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler(async (webContents, permission, callback) => {
    if (permission === 'media') {
      const window = BrowserWindow.fromWebContents(webContents) ?? undefined;
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['Allow', 'Deny'],
        defaultId: 0,
        cancelId: 1,
        title: 'Media access request',
        message: 'Curly Broccoli Chat wants to access your microphone/camera.',
      });
      callback(result.response === 0);
      return;
    }

    callback(false);
  });

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const window = BrowserWindow.getFocusedWindow() ?? undefined;
      const response = await dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['Share screen', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Screen sharing request',
        message: 'Curly Broccoli Chat wants to share your screen.',
      });

      if (response.response !== 0) {
        callback({ video: undefined, audio: undefined });
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback({ video: sources[0], audio: 'loopback' });
    },
    { useSystemPicker: true },
  );
}

app.whenReady().then(() => {
  setupIpc();
  setupPermissions();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
