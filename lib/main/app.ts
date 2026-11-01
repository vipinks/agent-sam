import { BrowserWindow, shell, app } from 'electron'
import { join } from 'path'
import { createWindowManager } from 'electron-conveyor/main'
import appIcon from '@/resources/build/icon.png?asset'
import { setupEvents } from '@/conveyor/router'
import { createSplashController } from './splash'

/** Tracks every window by label; the substrate for cross-window targeting (`ctx.windows`). */
export const windows = createWindowManager()

let windowCount = 0

interface AppWindowOptions {
  /** The startup splash: a second surface with its own lifecycle and no conveyor registration. */
  splash?: boolean
  /** Startup main is revealed by the splash controller; ordinary windows keep their own show. */
  showOnReady?: boolean
}

/** Open a new tracked app window. `page` deep-links it onto an app page (via the URL hash). */
export function openAppWindow(page?: string): BrowserWindow {
  windowCount += 1
  const label = windowCount === 1 ? 'main' : `window-${windowCount}`
  return windows.register(label, createAppWindow(page))
}

/**
 * Create an app window. `hash` deep-links it: the renderer receives it as `location.hash`, so a
 * window can open straight onto a given route/view instead of the app's default.
 *
 * The splash is the one caller that is not a conveyor window: it shares this constructor's load
 * plumbing and preload, but is never registered and never receives `setupEvents`.
 */
export function createAppWindow(hash?: string, options: AppWindowOptions = {}): BrowserWindow {
  const splash = options.splash === true

  // Create the window.
  const mainWindow = new BrowserWindow({
    width: splash ? 480 : 1240,
    height: splash ? 480 : 780,
    show: false,
    backgroundColor: '#0e1011',
    frame: false,
    ...(splash
      ? { resizable: false, skipTaskbar: true, center: true }
      : {
          minWidth: 720,
          minHeight: 520,
          icon: appIcon,
          titleBarStyle: 'hiddenInset' as const,
          title: 'Agent Sam',
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // The conveyor preload is sandbox-compatible (contextBridge + ipcRenderer only), so the
      // renderer runs fully sandboxed — keep it that way.
      sandbox: true,
    },
  })

  if (!splash) {
    // Wire per-window push events. Procedure handlers are registered once, globally, via the
    // `@/conveyor/router` import side-effect and resolve the calling window from each invoke.
    setupEvents(mainWindow)

    mainWindow.on('ready-to-show', () => {
      if (options.showOnReady !== false) mainWindow.show()
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Only hand http(s) URLs to the OS — never arbitrary protocol handlers.
      try {
        const { protocol } = new URL(url)
        if (protocol === 'https:' || protocol === 'http:') shell.openExternal(url)
      } catch {
        // malformed URL — ignore
      }
      return { action: 'deny' }
    })
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash ? `#${hash}` : ''}`)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }

  return mainWindow
}

/** Show the startup splash from its own paint, then hand off on main's native ready-to-show. */
export function openStartupWindows(): void {
  windowCount += 1
  const mainWindow = windows.register('main', createAppWindow(undefined, { showOnReady: false }))
  const splashWindow = createAppWindow('splash', { splash: true })
  const controller = createSplashController({
    now: Date.now,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    port: {
      showSplash: () => splashWindow.show(),
      closeSplash: () => splashWindow.close(),
      showMain: () => mainWindow.show(),
    },
  })

  mainWindow.on('ready-to-show', () => controller.mainReady())
  splashWindow.on('ready-to-show', () => controller.start())
  splashWindow.on('closed', () => controller.splashClosed())
  mainWindow.webContents.on('did-fail-load', () => controller.failed())
  mainWindow.webContents.on('render-process-gone', () => controller.failed())
  app.once('before-quit', () => controller.beforeQuit())
}
