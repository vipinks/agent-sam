// First, for its side effect: fixes userData before the router import below reads persisted state.
// Ordering matters and is explained in that module; moving this import is a data-loss bug.
import { identity } from './identity'
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { openAppWindow } from './app'
import { registerResourcesProtocol } from './protocols'

// Chromium only auto-detects a keyring on desktops it recognizes, so on anything else (Hyprland,
// sway, bare WMs) safeStorage silently degrades to `basic_text` and reports itself unavailable.
// Naming the backend opts back in where a secret service is actually running; if none is, Chromium
// falls back on its own. Must run before the app is ready.
if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'gnome-libsecret')

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows. Kept in step with the appId in electron-builder.yml, so the
  // Windows taskbar/notification identity, the installer entry and the window title all agree.
  electronApp.setAppUserModelId('com.samai.desktop')
  // One line of evidence that the identity pin took effect, written before any window opens. Logged
  // at warn level because this is the app's only startup assertion about where its data lives, and the
  // house `no-console` rule allows warn/error precisely so a diagnostic does not have to weaken it.
  console.warn(`[identity] ${identity.displayName} :: userData=${identity.userData}`)

  // Register the custom resources protocol once. The IPC surface (modules, stores, context) is
  // registered by the `@/conveyor/router` import side-effect via ./app.
  registerResourcesProtocol()

  // Open the main window.
  openAppWindow()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      openAppWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file, you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
