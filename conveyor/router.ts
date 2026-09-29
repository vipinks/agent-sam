import type { BrowserWindow } from 'electron'
import { createRouter, createEmitter, devLogger } from 'electron-conveyor/main'
import { windows, openAppWindow } from '@/lib/main/app'
import { windowModule, setupWindowEvents } from './modules/window'
import { systemModule } from './modules/system'
import { webModule } from './modules/web'
import { workspaceModule } from './modules/workspace'
import { settingsModule, setCustomProviderIds } from './modules/settings'
import { providerModule } from './modules/provider'
import { llmModule } from './modules/llm'
import { terminalModule } from './modules/terminal'
import {
  terminalPtyModule,
  ptySessions,
  killOnRootRemoval,
  setTerminalEventSink,
  setTerminalScrollbackSource,
} from './modules/terminal-pty'
import { agentModule, setContextSnapshotSink } from './modules/agent'
import { sessionsModule, sweepOrphanedTranscripts } from './modules/sessions'
import { imageAttachmentsModule, sweepAttachmentFolders } from './modules/image-attachments'
import { mentionsModule } from './modules/mentions'
import { skillsModule, setSkillPruneSink } from './modules/skills'
import { mcpModule } from './modules/mcp'
import { gitModule } from './modules/git'
import { workspaceStore } from './stores/workspace'
import { providerConfigStore } from './stores/provider-config'
import { chatSessionsStore } from './stores/chat-sessions'
import { terminalPreferencesStore } from './stores/terminal-preferences'
import { contextPreferencesStore } from './stores/context-preferences'
import { buddiesStore } from './stores/buddies'
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
    system: systemModule,
    web: webModule,
    workspace: workspaceModule,
    settings: settingsModule,
    provider: providerModule,
    llm: llmModule,
    terminal: terminalModule,
    terminalPty: terminalPtyModule,
    agent: agentModule,
    sessions: sessionsModule,
    attachments: imageAttachmentsModule,
    mentions: mentionsModule,
    skills: skillsModule,
    mcp: mcpModule,
    git: gitModule,
  },
  {
    createContext: () => ({ appStartedAt: APP_STARTED_AT, windows, openWindow: openAppWindow }),
    stores: [
      workspaceStore,
      providerConfigStore,
      chatSessionsStore,
      terminalPreferencesStore,
      contextPreferencesStore,
      buddiesStore,
    ], // main holds the state; every window mirrors it live
    use: [devLogger], // per-call timing in dev, a no-op in packaged builds
  }
)

export type AppRouter = typeof router

/**
 * Take the retired provider-level rate keys off the loaded records.
 *
 * Runs once, here, immediately after the router exists and synchronously — before any window is opened
 * and before the store's next save — because the load itself cannot do it: conveyor spreads the persisted
 * state over the initial state one level deep, so a `providers` map read from the file arrives with
 * whatever keys the file carried, a record's own retired keys included.
 *
 * Through the store's own action rather than by editing the handle's state, so the normalisation is the
 * definition's and cannot drift from a second copy here: main dispatches it like any other action, and
 * the debounced write that follows persists the stripped slice.
 */
router.stores['provider-config'].dispatch('dropRetiredRates')

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
 * Clear attachment folders whose session is gone, by the same rule and for the same reason.
 *
 * Beside the transcript sweep rather than inside it, because the two clean up different things and fail
 * independently: a transcript file and an attachment folder are removed by separate steps of a delete,
 * so either can be left behind without the other. The ids are the same list read at the same moment, so
 * a folder that survives one sweep cannot survive the other. Not awaited, for the reason neither sweep
 * is: startup must not wait on housekeeping, and a failure here is housekeeping failing.
 */
void sweepAttachmentFolders(router.stores['chat-sessions'].getState().sessions.map((s) => s.id))
  .then((swept) => {
    if (swept > 0) console.warn(`[attachments] swept ${swept} orphaned attachment folder(s)`)
  })
  .catch((error: unknown) => {
    console.warn('[attachments] attachment sweep failed', error)
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
 * Fan out a shell's output, and its ending, to every window.
 *
 * Broadcast rather than addressed, and declared here for the reason the sink above is: `createEmitter`
 * needs the module's id, which `createRouter` has only just assigned, and `terminal-pty.ts` is imported
 * *by* this file — so the registry is built before this moment and reaches its wire through
 * `setTerminalEventSink` instead of holding one.
 *
 * Every window receives every root's chunks, and the renderer drops the ones that are not its own root.
 * The alternative — main tracking which window is showing which folder — would put a renderer's view
 * state in main, where it would be stale the moment a pane was undocked.
 */
const emitTerminal = createEmitter(terminalPtyModule, () => windows.broadcast())
setTerminalEventSink({ data: emitTerminal.data, exit: emitTerminal.exit })

/**
 * Tell the settings module which providers the user has added, so a key may be saved for one.
 *
 * Installed here for the same reason the sink above is: the store does not exist until `createRouter`
 * has returned, and `settings.ts` is imported *by* this file — a module reaching for the router would
 * close the cycle. Read through a function rather than handed over as a list, because the list a user
 * adds to is not the list this file saw at startup.
 */
setCustomProviderIds(() => router.stores['provider-config'].getState().customProviders.map((p) => p.id))

/**
 * Give the skills module the session store, so switching a skill off can take it out of every conversation.
 *
 * Installed here for the same reason as the two sinks above: the store does not exist until `createRouter`
 * has returned, and the module is imported *by* this file. Dispatched rather than written, because pruning
 * is a change to session state and the store is the only thing that owns one.
 */
setSkillPruneSink((skillId) => router.stores['chat-sessions'].dispatch('dropSkill', { id: skillId }))

/**
 * Give the agent loop the session store, so a request it measures lands on the conversation it was built for.
 *
 * Installed here for the same reason as the sinks above: the store does not exist until `createRouter` has
 * returned, and the module is imported *by* this file, so a loop reaching for the router from its own side
 * would close the cycle. Dispatched rather than written, because a measured request is a change to session
 * state and the store is the only thing that owns one — and it is dispatched through the same debounced
 * save every other write here goes through, so a turn that takes several round-trips does not pay a write
 * per reply.
 *
 * The loop holds no session of its own: it is handed one with each run, and the sink is told which one the
 * measurement belongs to. A run told no conversation measures nothing and calls nothing, which is what
 * keeps this from having to invent a record for a turn nobody owns.
 */
setContextSnapshotSink(({ sessionId, snapshot }) =>
  router.stores['chat-sessions'].dispatch('recordContextSnapshot', { id: sessionId, snapshot })
)

/**
 * End the shell of a folder the user has stopped being offered.
 *
 * Installed here for the same reason as the three sinks above: the store does not exist until
 * `createRouter` has returned, and this module is imported *by* this file, so reaching for the router
 * from inside it would close the cycle. The roots are read through a function and changes arrive
 * through the store's own subscription rather than being handed over as a list, because the list a
 * user changes is not the list this file saw at startup — and the module takes the difference against
 * the list it last saw, so an open that reorders the recents does not end a shell nobody forgot.
 */
killOnRootRemoval(
  ptySessions,
  () => router.stores['workspace'].getState().recentRoots,
  (listener) => router.stores['workspace'].subscribe((state) => listener(state.recentRoots))
)

/**
 * Give the PTY registry the scrollback preference, so a shell is created with the limit the user set.
 *
 * Installed here for the same reason as the four sinks above: the store does not exist until
 * `createRouter` has returned, and the registry was built while this file was being imported. Read
 * through a function rather than handed over as a number, because the limit a user changes in Settings
 * is not the value this file saw at startup — and main reads it once per session, which is what makes a
 * change govern the next shell rather than resize a running one's transcript.
 */
setTerminalScrollbackSource(() => router.stores['terminal-preferences'].getState().scrollbackLines)

/** Wire per-window push events. Call once per created window. */
export function setupEvents(win: BrowserWindow): void {
  setupWindowEvents(win)
}
