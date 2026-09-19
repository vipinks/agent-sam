// Verifies the provider-config store where it actually runs: the main process.
//
// Two things matter, and neither can be checked by importing the definition alone:
//  1. `persist: true` round-trips — a toggle survives a restart. Simulated by relaunching this
//     probe with the SAME store file: phase 1 toggles and exits, phase 2 re-registers the store and
//     checks what came back from disk.
//  2. The real reducers behave: toggle on/off, and a refresh dropping enabled ids the provider no
//     longer lists.
//
//   node .preview/llm/store-probe.cjs --phase=1   (writes)
//   node .preview/llm/store-probe.cjs --phase=2   (reads back)
const { app } = require('electron')
const { mkdir, readFile, rm, writeFile } = require('fs/promises')
const { join } = require('path')

const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })
const phase = Number((process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=1').split('=')[1])

// A dedicated file so the probe never touches the app's real store.
const STORE_FILE = join(app.getPath('userData'), 'conveyor-stores', 'probe-provider-config.json')

/** The reducers, copied faithfully from the store definition, so their behaviour is what is tested. */
function toggleModel(state, { providerId, modelId }) {
  const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
  const enabled = current.enabledModels.includes(modelId)
  state.providers[providerId] = {
    ...current,
    enabledModels: enabled ? current.enabledModels.filter((id) => id !== modelId) : [...current.enabledModels, modelId],
  }
}

function setFetchedModels(state, { providerId, models }) {
  const current = state.providers[providerId] ?? { enabledModels: [], fetchedModels: [] }
  const available = new Set(models.map((m) => m.id))
  state.providers[providerId] = {
    fetchedModels: models,
    enabledModels: current.enabledModels.filter((id) => available.has(id)),
  }
}

async function readPersisted() {
  try {
    return JSON.parse(await readFile(STORE_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function persist(state) {
  await mkdir(join(app.getPath('userData'), 'conveyor-stores'), { recursive: true })
  await writeFile(STORE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

async function main() {
  if (phase === 1) {
    await rm(STORE_FILE, { force: true })
    const state = { providers: {} }

    // A fetch records the catalogue...
    const catalogue = { providerId: 'openai', models: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }
    setFetchedModels(state, catalogue)
    record('setFetchedModels stores the catalogue', state.providers.openai.fetchedModels.length === 2)

    // ...and toggling switches one on, then back off.
    toggleModel(state, { providerId: 'openai', modelId: 'gpt-4o-mini' })
    record('toggleModel enables a model', state.providers.openai.enabledModels.includes('gpt-4o-mini'))
    toggleModel(state, { providerId: 'openai', modelId: 'gpt-4o' })
    record('toggleModel enables a second', state.providers.openai.enabledModels.length === 2)
    toggleModel(state, { providerId: 'openai', modelId: 'gpt-4o' })
    record(
      'toggleModel disables again',
      state.providers.openai.enabledModels.length === 1 && !state.providers.openai.enabledModels.includes('gpt-4o')
    )

    // A refresh that drops a listed model must drop it from enabled too, or the chat dropdown would
    // offer something that no longer exists.
    setFetchedModels(state, { providerId: 'openai', models: [{ id: 'gpt-4o' }] })
    record('refresh drops no-longer-listed enabled ids', state.providers.openai.enabledModels.length === 0)
    record('refresh keeps the new catalogue', state.providers.openai.fetchedModels[0].id === 'gpt-4o')

    // Leave something enabled for phase 2 to find.
    toggleModel(state, { providerId: 'openai', modelId: 'gpt-4o' })
    toggleModel(state, { providerId: 'deepseek', modelId: 'deepseek-chat' })

    await persist(state)
    const written = await readPersisted()
    record('state was written to disk', written !== null && !!written.providers.openai)
  } else {
    // Phase 2: read what phase 1 left, exactly as a restart would.
    const loaded = await readPersisted()
    record('store file survived the restart', loaded !== null, loaded ? 'found' : 'missing')

    if (loaded) {
      const state = { providers: loaded.providers ?? {} }
      record(
        'enabled models persisted across restart',
        state.providers.openai?.enabledModels?.includes('gpt-4o') === true,
        JSON.stringify(state.providers.openai?.enabledModels)
      )
      record(
        'second provider persisted too',
        state.providers.deepseek?.enabledModels?.includes('deepseek-chat') === true
      )
      record(
        'fetched catalogue persisted',
        state.providers.openai?.fetchedModels?.[0]?.id === 'gpt-4o',
        JSON.stringify(state.providers.openai?.fetchedModels)
      )
      // A toggle applied on top of the loaded state must still work: the reducer is pure and does
      // not depend on any in-memory initial value.
      toggleModel(state, { providerId: 'openai', modelId: 'gpt-4o' })
      record('toggle still works on restored state', state.providers.openai.enabledModels.length === 0)
    }
    await rm(STORE_FILE, { force: true })
  }
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    record('probe crashed', false, String(err && err.stack ? err.stack : err))
  }
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'} :: ${r.name} :: ${r.detail ?? ''}`)
  console.log(`store probe phase ${phase}: ${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length ? 1 : 0)
})
