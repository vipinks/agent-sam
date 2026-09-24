import type { BrowserWindow } from 'electron'
import { createRouter, createEmitter, devLogger } from 'electron-conveyor/main'
import { windows, openAppWindow } from '@/lib/main/app'
import { windowModule, setupWindowEvents } from './modules/window'
import { webModule } from './modules/web'
import { workspaceModule } from './modules/workspace'
import { settingsModule, setCustomProviderIds } from './modules/settings'
import { providerModule } from './modules/provider'
import { llmModule } from './modules/llm'
import { terminalModule } from './modules/terminal'
import { agentModule } from './modules/agent'
import { sessionsModule, sweepOrphanedTranscripts } from './modules/sessions'
import { mentionsModule } from './modules/mentions'
import { skillsModule } from './modules/skills'
import { mcpModule } from './modules/mcp'
import { gitModule } from './modules/git'
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
    provider: providerModule,
    llm: llmModule,
    terminal: terminalModule,
    agent: agentModule,
    sessions: sessionsModule,
    mentions: mentionsModule,
    skills: skillsModule,
    mcp: mcpModule,
    git: gitModule,
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
 * Land the launch on the home screen.
 *
 * The chat store's pointer — which conversation is open — is persisted, so the state just restored
 * names the conversation that was open when the app was last closed. A window that reads that pointer
 * opens it, so a launch would come up on a conversation rather than on home: the screen a window with
 * nothing open belongs on, and the one whose whole subject is what to do next. The store's own step
 * clears it, leaving the conversation list intact for that screen to offer back.
 *
 * Here, beside the sweep and for the same reason: this is the first moment the store is readable, and
 * it is before any window exists — so there is no window to tell, and the state every window mirrors
 * already has nothing open.
 */
router.stores['chat-sessions'].dispatch('landOnHome')

/**
 * Fan out workspace changes to every window.
 *
 * Declared here rather than in a module because `createEmitter` needs the module's id, which
 * `createRouter` has only just assigned — and because the emitter is module-independent: both the
 * workspace module and the terminal module raise the same event, and they share this one sink.
 */
const emitWorkspaceChanged = createEmitter(workspaceModule, () => windows.broadcast())
setWorkspaceChangeSink(emitWorkspaceChanged.onChanged)

/**
 * Tell the settings module which providers the user has added, so a key may be saved for one.
 *
 * Installed here for the same reason the sink above is: the store does not exist until `createRouter`
 * has returned, and `settings.ts` is imported *by* this file — a module reaching for the router would
 * close the cycle. Read through a function rather than handed over as a list, because the list a user
 * adds to is not the list this file saw at startup.
 */
setCustomProviderIds(() => router.stores['provider-config'].getState().customProviders.map((p) => p.id))

/** Wire per-window push events. Call once per created window. */
export function setupEvents(win: BrowserWindow): void {
  setupWindowEvents(win)
}
