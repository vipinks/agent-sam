import type { BrowserWindow } from 'electron'
import { createRouter, createEmitter, devLogger } from 'electron-conveyor/main'
import { windows, openAppWindow } from '@/lib/main/app'
import { windowModule, setupWindowEvents } from './modules/window'
import { systemModule } from './modules/system'
import { webModule } from './modules/web'
import { workspaceModule } from './modules/workspace'
import {
  settingsModule,
  setCustomProviderIds,
  clearProviderKey,
  DEFAULT_MODELS,
  configuredProviderIdsSync,
} from './modules/settings'
import { PROVIDERS } from './protocol/providers'
import {
  combosModule,
  setCombosSink,
  setComboRegistrySource,
  buildComboRegistrySnapshot,
  loadCombosSync,
} from './modules/combos'
import { combosStore } from './stores/combos'
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
import {
  memoryModule,
  setMemoryPagesSink,
  setMemoryEpisodesSink,
  setEpisodesEnabledSource,
  setSessionRootSource,
  refreshMemoryPagesForRoot,
} from './modules/memory'
import { sessionsModule, setSessionMoveSink, sweepOrphanedTranscripts } from './modules/sessions'
import { imageAttachmentsModule, sweepAttachmentFolders } from './modules/image-attachments'
import { mentionsModule } from './modules/mentions'
import { skillsModule, setSkillPruneSink } from './modules/skills'
import { mcpModule } from './modules/mcp'
import { gitModule } from './modules/git'
import { updatesModule, setUpdateStatusSink, setAutoDownloadSource } from './modules/updates'
import {
  engineModule,
  setEngineBinaryPathSink,
  setEngineCatalogueSink,
  setEngineConsentSink,
  setEnginePreferenceSource,
  setEngineStatusSink,
  refreshEngineStatus,
} from './modules/engine'
import { workspaceStore } from './stores/workspace'
import { providerConfigStore, setCustomProviderDeleteSink } from './stores/provider-config'
import { chatSessionsStore } from './stores/chat-sessions'
import { terminalPreferencesStore } from './stores/terminal-preferences'
import { contextPreferencesStore } from './stores/context-preferences'
import { buddiesStore } from './stores/buddies'
import { appearancePreferencesStore } from './stores/appearance-preferences'
import { updatePreferencesStore } from './stores/update-preferences'
import { updateStatusStore } from './stores/update-status'
import { engineConsentStore } from './stores/engine-consent'
import { enginePreferencesStore } from './stores/engine-preferences'
import { engineStatusStore } from './stores/engine-status'
import { engineModelsStore } from './stores/engine-models'
import { memoryStore } from './stores/memory'
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
    updates: updatesModule,
    engine: engineModule,
    memory: memoryModule,
    combos: combosModule,
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
      appearancePreferencesStore,
      updatePreferencesStore,
      updateStatusStore,
      engineConsentStore,
      enginePreferencesStore,
      engineStatusStore,
      engineModelsStore,
      memoryStore,
      combosStore,
    ], // main holds the state; every window mirrors it live
    use: [devLogger], // per-call timing in dev, a no-op in packaged builds
  }
)

export type AppRouter = typeof router

/**
 * Give the combos resolvers one frozen registry, and load the combos file before any window exists.
 *
 * The sink first: the member guard and the eligibility walk both read it, and the module that owns
 * the file is imported *by* this file, so it cannot reach the stores itself. Read through a function
 * rather than handed a snapshot, because the models a user switches on are not the models this file
 * saw at startup — every request re-reads it.
 *
 * The load is synchronous and sits here, after `createRouter` and before any window: the store holds
 * what the file says from the first moment a renderer can ask, and a save triggered by the first
 * query cannot write an empty list over a file that has combos in it. That ordering is the whole
 * point of the call, so it is not awaited or deferred.
 */
setCombosSink((combos) => router.stores['combos'].dispatch('replace', { combos }))
setComboRegistrySource(() => {
  const providerConfig = router.stores['provider-config'].getState()
  return buildComboRegistrySnapshot({
    providers: PROVIDERS.map((provider) => ({ id: provider.id, name: provider.name })),
    custom: providerConfig.customProviders,
    defaults: DEFAULT_MODELS,
    configs: providerConfig.providers,
    configured: configuredProviderIdsSync(),
  })
})
loadCombosSync()

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
 * Give a provider's removal the means to clear its credential, in the same action.
 *
 * The store owns the list and the provider's model record, but not the key file: a credential is never
 * written into a store that every window mirrors. So the delete hands the id here, where main's own
 * function forgets it — the deletion is one act rather than a state write and a renderer's later
 * request that can fail unobserved. The catch is housekeeping reported rather than a delete that
 * throws after the provider has already gone; there is nothing left for the caller to retry.
 */
setCustomProviderDeleteSink((providerId) => {
  void clearProviderKey(providerId).catch((error: unknown) => {
    console.warn('[settings] a deleted provider key could not be cleared', error)
  })
})

/**
 * Give the skills module the session store, so switching a skill off can take it out of every conversation.
 *
 * Installed here for the same reason as the two sinks above: the store does not exist until `createRouter`
 * has returned, and the module is imported *by* this file. Dispatched rather than written, because pruning
 * is a change to session state and the store is the only thing that owns one.
 */
setSkillPruneSink((skillId) => router.stores['chat-sessions'].dispatch('dropSkill', { id: skillId }))

/**
 * Give the sessions module the session store, so a move lands on the row it named.
 *
 * Installed here for the same reason as the sink above: the store does not exist until `createRouter` has
 * returned, and `sessions.ts` is imported *by* this file. Dispatched rather than written, because the
 * project a conversation belongs to is session state and the store is the only thing that owns one — and
 * because a move has to reach every window, which only a store change is broadcast to: that is what makes
 * the row leave its group and land under the destination's.
 *
 * `touchSession` is the action, rather than a write of this file's own, because it is already the one
 * place a record's project is stamped; the timestamp it stamps is what puts the destination group at the
 * top of the list, a move being activity like any other. The command hands this sink an id and a folder
 * and nothing else crosses: nothing on the disk is involved — one sessions directory holds every
 * project's conversations — so there is no file for this to move and no path for the renderer to see.
 */
setSessionMoveSink(({ id, destination }) =>
  router.stores['chat-sessions'].dispatch('touchSession', { id, lastRoot: destination })
)

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
 * Give the memory module the memory store, so a mutation mirrors the four page summaries to every window.
 *
 * Installed here for the reason the sinks above are: the store does not exist until `createRouter` has
 * returned, and the module is imported *by* this file. Dispatched rather than written, because the page
 * summaries are memory state and the store is the only thing that owns one — and because a write has to
 * reach every window, which only a store change is broadcast to.
 */
setMemoryPagesSink((pages) => router.stores['memory'].dispatch('setPages', { pages }))

/**
 * Mirror the captured episode rows, on the same terms and for the same reason as the page summaries.
 *
 * A push only where the panel's preview is refreshed — launch and its own listPages — never per
 * capture. An episode is written on disk by the save it rides on, and a store broadcast per completed
 * turn is exactly the chatter the transcript's out-of-store design exists to avoid.
 */
setMemoryEpisodesSink((episodes) => router.stores['memory'].dispatch('setEpisodes', { episodes }))

/**
 * Give episodic capture its two reads: the consent switch, and the folder a conversation belongs to.
 *
 * Both are reads through functions rather than values, because the switch a user flips and the folder
 * a conversation is used in are not the values this file saw at startup. The folder comes from the
 * session record's `lastRoot` — the project a conversation's work actually happened in — rather than
 * from whichever folder a window happens to have open, so a save of a background session lands under
 * its own project.
 */
setEpisodesEnabledSource(() => router.stores['memory'].getState().episodesEnabled)
setSessionRootSource((sessionId) => {
  const record = router.stores['chat-sessions'].getState().sessions.find((session) => session.id === sessionId)
  return record?.lastRoot ?? null
})

/**
 * Seed the memory store for the folder open at launch, so the panel's tab row has a durable view before
 * it is first docked. Not awaited, like the sweeps: startup must not wait on housekeeping, and a failure
 * here is housekeeping failing rather than the app failing to start.
 */
void refreshMemoryPagesForRoot(router.stores['workspace'].getState().rootPath).catch((error: unknown) => {
  console.warn('[memory] launch seed failed', error)
})

/**
 * End the shell of a folder the user has stopped being offered.
 *
 * Installed here for the same reason as the sinks above: the store does not exist until
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

/**
 * Give the updater the auto-download preference, and the status store its transitions.
 *
 * Installed here for the reason the five sinks above are: neither store exists until `createRouter` has
 * returned, and the updates module is imported *by* this file — a module reaching for the router would close
 * the cycle. The preference is read through a function, because the value a user flips is not the value this
 * file saw at startup; the status sink is the one place the updater's events become store transitions, so
 * every window mirrors what the updater reported rather than what a call asked it to do.
 *
 * The updater itself is not started here. `lib/main/main.ts` starts the schedule from the app-ready hook,
 * which is the first moment electron-updater may be configured and the moment the design names for it.
 */
setAutoDownloadSource(() => router.stores['update-preferences'].getState().autoDownload)
setUpdateStatusSink({
  read: () => router.stores['update-status'].getState().state,
  setCurrentVersion: (version) => router.stores['update-status'].dispatch('setCurrentVersion', { version }),
  startChecking: () => router.stores['update-status'].dispatch('startChecking'),
  recordAvailable: (version, at) => router.stores['update-status'].dispatch('recordAvailable', { version, at }),
  recordUpToDate: (at) => router.stores['update-status'].dispatch('recordUpToDate', { at }),
  startDownloading: () => router.stores['update-status'].dispatch('startDownloading'),
  recordReady: (version) => router.stores['update-status'].dispatch('recordReady', { version }),
  recordError: (code) => router.stores['update-status'].dispatch('recordError', { code }),
  recordPendingInstall: (install) => router.stores['update-status'].dispatch('recordPendingInstall', install),
  recordSacPolicyState: (state) => router.stores['update-status'].dispatch('recordSacPolicyState', { state }),
})

/**
 * Put an engine's permission question on the shield, and take it back when it is answered.
 *
 * A store dispatch rather than an event, because a question is state and not a notification: every window has
 * to mirror the one question that is pending — an event would leave a second window believing nothing is
 * being asked — and the answer arriving is the same state moving, which is what `clear` is.
 *
 * Declared here for the reason the sinks above are: the store only exists once the router does, and the
 * module that asks owns no store of its own.
 */
setEngineConsentSink({
  request: (consent) => router.stores['engine-consent'].dispatch('request', consent),
  clear: (requestId) => router.stores['engine-consent'].dispatch('clear', { requestId }),
})

/**
 * Let the engine rail read, and write, the preferences a user sets on it.
 *
 * Two directions, declared here for the reason the sinks above are: neither store exists until the router
 * does. The read is what makes a stored path and a stored mode reach the places that need them — a path is
 * resolved before a probe and before a turn, and the mode is what the launch arguments are built from — and
 * the write is the other half: a path is kept only after a probe has run it, so the save happens in the
 * module and lands in the store through here.
 *
 * The read is `getState` on the router's own handle rather than a mirror, because this is main: the state it
 * reads is the one it dispatches into, which is the state every window mirrors. `undefined` is answered for an
 * engine nobody has configured, and the protocol's own defaults fill that in — so the store never has to hold
 * a value nobody chose.
 */
setEnginePreferenceSource({
  read: (engineId) => router.stores['engine-preferences'].getState().engines[engineId],
})

setEngineBinaryPathSink({
  record: ({ engineId, path }) => router.stores['engine-preferences'].dispatch('recordBinaryPath', { engineId, path }),
  clear: ({ engineId }) => router.stores['engine-preferences'].dispatch('clearBinaryPath', { engineId }),
})

/**
 * Publish what is installed, once, as the app starts.
 *
 * The sink first, then the probe — never the other way round: the probe publishes when it answers, and a sink
 * installed afterwards would drop the answer on the floor and leave the picker saying "not installed" for the
 * rest of the session.
 *
 * Read after the preferences and not before: the startup probe measures the stored override, so the row a
 * launch draws is the binary a turn would run. Not awaited, like the sweeps above and for the same reason — a
 * window appearing must not wait on a process — so the rows land a moment later, with the picker drawing every
 * engine as not installed until they do.
 *
 * The failure is caught rather than left to surface: a probe is a read for the user's benefit, and a machine
 * that cannot start one has a picker that says "not installed", not a start that failed.
 */
setEngineStatusSink({
  record: (rows) => router.stores['engine-status'].dispatch('record', { rows }),
})

/**
 * Publish the catalogue an engine's session advertised, as the turn that read it observes it.
 *
 * Wired here rather than read by the header's control, and for the reason the rows above are wired here: the only
 * way to read an engine's catalogue is to open a session with it, which is a process. A turn already opens one, so
 * the turn is where the advertisement is read — and this sink is what makes it *state*, so the control is drawn
 * from a list somebody actually read rather than from a second session opened to answer the same question.
 */
setEngineCatalogueSink({
  record: ({ engineId, catalogue }) => router.stores['engine-models'].dispatch('record', { engineId, catalogue }),
})

void refreshEngineStatus().catch((error: unknown) => {
  console.warn('[engine] the startup probe failed', error)
})

/** Wire per-window push events. Call once per created window. */
export function setupEvents(win: BrowserWindow): void {
  setupWindowEvents(win)
}
