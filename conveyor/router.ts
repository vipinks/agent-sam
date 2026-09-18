import type { BrowserWindow } from 'electron'
import { createRouter, createEmitter, devLogger } from 'electron-conveyor/main'
import { windows, openAppWindow } from '@/lib/main/app'
import { windowModule, setupWindowEvents } from './modules/window'
import { webModule } from './modules/web'
import { workspaceModule } from './modules/workspace'
import { settingsModule } from './modules/settings'
import { llmModule } from './modules/llm'
import { terminalModule } from './modules/terminal'
import { agentModule } from './modules/agent'
import { sessionsModule } from './modules/sessions'
import { workspaceStore } from './stores/workspace'
import { providerConfigStore } from './stores/provider-config'
import { chatSessionsStore } from './stores/chat-sessions'
import { setWorkspaceChangeSink } from './events'

/**
 * The app's whole IPC surface — modules, stores, context, global middleware — registered in one
 * place. Runtime is MAIN-ONLY; the renderer imports only `type AppRouter`. `window` and `web` are
 * the core modules (the titlebar needs them); add your own next to them in `modules/`.
 */

/** Main-process start time — surfaced to handlers as `ctx.appStartedAt`. */
const APP_STARTED_AT = Date.now()

export const router = createRouter(
  {
    window: windowModule,
    web: webModule,
    workspace: workspaceModule,
    settings: settingsModule,
    llm: llmModule,
    terminal: terminalModule,
    agent: agentModule,
    sessions: sessionsModule,
  },
  {
    createContext: () => ({ appStartedAt: APP_STARTED_AT, windows, openWindow: openAppWindow }),
    stores: [workspaceStore, providerConfigStore, chatSessionsStore], // main holds the state; every window mirrors it live
    use: [devLogger], // per-call timing in dev, a no-op in packaged builds
  }
)

export type AppRouter = typeof router

/**
 * Fan out workspace changes to every window.
 *
 * Declared here rather than in a module because `createEmitter` needs the module's id, which
 * `createRouter` has only just assigned — and because the emitter is module-independent: both the
 * workspace module and the terminal module raise the same event, and they share this one sink.
 */
const emitWorkspaceChanged = createEmitter(workspaceModule, () => windows.broadcast())
setWorkspaceChangeSink(emitWorkspaceChanged.onChanged)

/** Wire per-window push events. Call once per created window. */
export function setupEvents(win: BrowserWindow): void {
  setupWindowEvents(win)
}
