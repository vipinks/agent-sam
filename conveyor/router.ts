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
import { sessionsModule, sweepOrphanedTranscripts } from './modules/sessions'
import { mentionsModule } from './modules/mentions'
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
    mentions: mentionsModule,
  },
  {
    createContext: () => ({ appStartedAt: APP_STARTED_AT, windows, openWindow: openAppWindow }),
    stores: [workspaceStore, providerConfigStore, chatSessionsStore], // main holds the state; every window mirrors it live
    use: [devLogger], // per-call timing in dev, a no-op in packaged builds
  }
)

export type AppRouter = typeof router

/**
 * Clear transcript files left behind by a delete that removed the metadata but not the file.
 *
 * Runs once, here, immediately after the router exists — because that is the first moment the store
 * is readable, and reading it is what makes the sweep correct.
 *
 * The store loads its persisted state synchronously during `createRouter` (conveyor reads the JSON
 * before returning), so by this point `getState()` reflects what was restored from disk. A sweep run
 * any earlier would see an empty session list and delete every transcript on disk — the failure this
 * ordering exists to avoid.
 *
 * Not awaited: startup must not wait on housekeeping, and a failure here is housekeeping failing
 * rather than the app failing to start. The rejection is caught so it cannot surface as an
 * unhandled rejection either.
 */
void sweepOrphanedTranscripts(router.stores['chat-sessions'].getState().sessions.map((s) => s.id))
  .then((swept) => {
    if (swept > 0) console.warn(`[sessions] swept ${swept} orphaned transcript file(s)`)
  })
  .catch((error: unknown) => {
    console.warn('[sessions] transcript sweep failed', error)
  })

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
