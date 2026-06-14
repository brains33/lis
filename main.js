/**
 * main.js — MU'UJIZA DIAGNOSTICS LIS Desktop App
 * Electron main process: creates the window, handles security,
 * manages updates and offline detection.
 */

const { app, BrowserWindow, shell, dialog, Menu, ipcMain, nativeTheme } = require('electron')
const path = require('path')

// ── Security: prevent navigation to external URLs ────────────────────────────
const ALLOWED_ORIGINS = ['file://', 'supabase.co', 'paystack.co', 'paystack.com']
function isAllowedUrl(url) {
  return ALLOWED_ORIGINS.some(o => url.startsWith(o) || url.includes(o))
}

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isAllowedUrl(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 620, height: 700, autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        },
      }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
})

// ── Create main window ───────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "MU'UJIZA DIAGNOSTICS – LIS",
    icon: path.join(__dirname, 'icon-512.png'),
    backgroundColor: '#eef2f9',
    show: false, // show only after ready-to-show for a clean launch
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  // Show login page (files are in root, not app/ subfolder)
  win.loadFile(path.join(__dirname, 'login.html'))

  // Show window once page is ready — no white flash
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Confirm before closing while a session may be active
  win.on('close', e => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Stay', 'Exit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Exit MU\'UJIZA LIS',
      message: 'Are you sure you want to exit?',
      detail: 'Any unsaved work will be lost.',
      icon: path.join(__dirname, 'icon-512.png'),
    })
    if (choice === 0) e.preventDefault()
  })

  return win
}

// ── App menu (minimal — no developer clutter) ────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'Application',
      submenu: [
        { label: "MU'UJIZA LIS v" + app.getVersion(), enabled: false },
        { type: 'separator' },
        {
          label: 'Reload Page', accelerator: 'CmdOrCtrl+R',
          click: (_, win) => win?.webContents.reload()
        },
        {
          label: 'Toggle Full Screen', accelerator: 'F11',
          click: (_, win) => { if (win) win.setFullScreen(!win.isFullScreen()) }
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Cut',   accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy',  accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About MU\'UJIZA LIS',
          click: (_, win) => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: "About MU'UJIZA LIS",
              message: "MU'UJIZA DIAGNOSTICS\nLaboratory Information System",
              detail: `Version: ${app.getVersion()}\nDeveloped by MU'UJIZA DATA\n© 2025 All rights reserved`,
              icon: path.join(__dirname, 'icon-512.png'),
              buttons: ['OK'],
            })
          }
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu()
  const win = createWindow()

  // ── Logout: load login.html from main process then re-focus the window.
  // On Windows, navigating via window.location in the renderer can leave the
  // new page's inputs unresponsive because the window loses input focus.
  // Doing it from main + calling focus() after did-finish-load fixes this.
  ipcMain.on('lis-logout', () => {
    win.loadFile(path.join(__dirname, 'login.html'))
    win.webContents.once('did-finish-load', () => {
      win.focus()
      win.webContents.focus()
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Prevent multiple instances of the app running at once
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length) { wins[0].restore(); wins[0].focus() }
  })
}
