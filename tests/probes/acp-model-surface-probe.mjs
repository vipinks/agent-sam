/**
 * Phase 82 the live ACP probe: do `kimi acp` and `opencode acp` expose model selection on the wire?
 *
 * Run with: node tests/probes/acp-model-surface-probe.mjs [kimi|opencode ...]
 *
 * One arm per engine, and each arm is the same four questions, asked of the agent itself rather than of a
 * document: what does `initialize` say, what does `session/new` advertise, is there a `session/set_model`, and
 * what exactly does the agent answer when it is handed a model id it does not know.
 *
 * Every frame in both directions is recorded verbatim — the requests, the responses including their error
 * objects, and the notifications — so the model advertisement, if there is one, is read as the agent wrote it
 * rather than as a field this probe hoped to find. `session/new`'s result is printed whole for that reason: an
 * engine that advertises nothing must be visible as an absence, not as a missing key nobody printed.
 *
 * A permission question is answered with the first `allow*` option the agent offered, or `cancelled` when it
 * offered none, so a probe run cannot hang on a question nobody is there to answer. Each engine's child is
 * killed in a `finally`, and the whole probe carries a watchdog, for the same reason.
 *
 * The candidate method names are tried in order and every answer is recorded: an agent that has no such method
 * answers with JSON-RPC's own `-32601` rather than by staying silent, which is exactly the evidence a feature
 * turn needs before it writes a call. The "good" id is the first model the agent advertised; the "bad" id is
 * fabricated, so the refusal is the agent's own words about a model that cannot exist.
 *
 * An engine that refuses `session/new` refuses everything downstream of it, and that refusal is an environment
 * the probe cannot configure rather than a defect in the probe: a CLI whose login has expired answers `-32000
 * Authentication required` and there is no session to ask about models. It is therefore recorded verbatim —
 * the code, the message, and the `authMethods` the agent offered — and counted as a skip with its reason
 * stated, alongside the engines whose binary is missing. What the probe fails on is only what is its own: a
 * spawn error, a call that times out, or a `session/new` that reports success without a session id.
 *
 * Nothing here imports the app: the point is to observe the agent, not to agree with our own client about what
 * it said. Exit 0 is the pass; an engine that cannot be measured is a stated skip, not a failure.
 *
 * `session/new` on a signed-in OpenCode answers with a model catalogue of several hundred entries. The ids are
 * recorded as a bounded sample with the count and an explicit truncation marker, because a probe whose log is
 * a megabyte of model names is a probe nobody reads — and `PROBE_FULL_MODELS=1` prints the catalogue whole for
 * the reader who does need every id.
 */
import { spawn, spawnSync } from 'node:child_process'

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 90_000)
const CWD = process.env.PROBE_CWD || process.cwd()
const START = Date.now()

/** The model id the "bad" call asks for. Unmistakable, so no installed model can answer to it by accident. */
const UNKNOWN_MODEL = 'phase82-not-a-real-model-xyz'

/** How many advertised model ids a log carries before it stops being evidence and starts being noise. */
const MODEL_SAMPLE = Number(process.env.PROBE_MODEL_SAMPLE || 12)
const FULL_MODELS = process.env.PROBE_FULL_MODELS === '1'

/**
 * The methods that could carry a model choice, each with the params it is asked in.
 *
 * `session/set_model` is the protocol's own written form and is asked first. `session/set_config_option` is
 * asked second because an agent that advertises its models as a *session config option* — a `select` whose
 * `category` is `model` — is one whose own equivalent of choosing a model is that call, and `modelId` is not a
 * field it reads. The two spellings are both ACP's; which one an agent implements is the agent's answer, not
 * this probe's assumption. The remaining two are the shapes a reader would guess at, asked so that the
 * guesswork is settled on the wire rather than in the feature turn.
 */
const CANDIDATE_METHODS = [
  { method: 'session/set_model', params: (sessionId, modelId) => ({ sessionId, modelId }) },
  {
    method: 'session/set_config_option',
    params: (sessionId, modelId, configId) => ({ sessionId, configId, value: modelId }),
  },
  { method: 'session/setModel', params: (sessionId, modelId) => ({ sessionId, modelId }) },
  { method: 'session/models', params: (sessionId, modelId) => ({ sessionId, modelId }) },
]

/**
 * A `session/new` result for the log, with its advertised catalogue replaced by the bounded sample.
 *
 * The advertisement is still recorded in the agent's own shape — the same keys, the same `currentModelId`, and
 * the ids in the order the agent gave them — but hundreds of model names are not usefully "verbatim" in a log
 * line, and a reader who needs every id has `PROBE_FULL_MODELS=1`. Everything else the agent said about the
 * session is passed through untouched, so nothing but the catalogue is ever abbreviated.
 */
function withoutCatalogue(result) {
  if (result === undefined || result === null || typeof result !== 'object') return result ?? null
  const models = result.models
  if (models === undefined || models === null) return result
  if (Array.isArray(models)) return { ...result, models: sampleOf(models) }
  if (Array.isArray(models.availableModels)) {
    return { ...result, models: { ...models, availableModels: sampleOf(models.availableModels) } }
  }
  return result
}

/**
 * Whether the CLI's *own* help names a model option, recorded for an engine whose ACP session cannot be opened.
 *
 * Asked of both the top-level command and the `acp` subcommand, because the two are different surfaces and an
 * engine that answers no session at all is still an engine whose command line may carry a model flag. Only lines
 * that mention a model are kept — a whole `--help` page is not evidence this probe needs, and the flag's own
 * line is what the feature turn would write into an argument array.
 */
function helpModelLines(bin) {
  const lines = []
  for (const args of [['acp', '--help'], ['--help']]) {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000, shell: false, windowsHide: true })
    if (result.error) continue
    const text = String(result.stdout || '') + String(result.stderr || '')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!/model/i.test(trimmed)) continue
      lines.push({ args, line: trimmed.slice(0, 200) })
    }
  }
  return lines.slice(0, 20)
}

/** How each engine is named on its wire and where its binary is looked for. */
const ENGINES = {
  kimi: { bin: process.env.KIMI_BIN || 'kimi' },
  opencode: { bin: process.env.PROBE_BIN || process.env.OPENCODE_BIN || 'opencode' },
}

function record(kind, payload) {
  process.stdout.write(JSON.stringify({ t: Date.now() - START, kind, ...payload }) + '\n')
}

/** Whether a binary can be spawned at all, asked the cheapest way: the CLI's own version line. */
function present(bin) {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, shell: false, windowsHide: true })
  if (probe.error) return { ok: false, reason: String(probe.error) }
  return { ok: true, text: (String(probe.stdout || '') + String(probe.stderr || '')).trim() }
}

/** One live agent on the pipe, with the framing the ACP transport is: one JSON message per line, both ways. */
function openChild(bin, label) {
  const child = spawn(bin, ['acp'], { cwd: CWD, shell: false, windowsHide: true })
  const state = { label, child, buffer: '', nextId: 1, waiting: new Map(), frames: [] }

  child.stdout.on('data', (chunk) => {
    state.buffer += String(chunk)
    let index = state.buffer.indexOf('\n')
    while (index !== -1) {
      const line = state.buffer.slice(0, index)
      state.buffer = state.buffer.slice(index + 1)
      if (line.trim() !== '') handleLine(state, line)
      index = state.buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => record('agent-stderr', { engine: label, text: String(chunk) }))
  child.on('error', (error) => record('child-error', { engine: label, message: String(error) }))
  child.on('close', (code, signal) => record('child-close', { engine: label, code, signal }))
  return state
}

function handleLine(state, line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    record('agent-nonjson', { engine: state.label, line })
    return
  }

  state.frames.push(message)

  if (message.id !== undefined && message.method === undefined) {
    record('response', { engine: state.label, message })
    const settle = state.waiting.get(message.id)
    if (settle) {
      state.waiting.delete(message.id)
      settle(message)
    }
    return
  }

  if (message.id !== undefined && typeof message.method === 'string') {
    record('agent-request', { engine: state.label, message })
    const options = message?.params?.options ?? []
    const allow = options.find((option) => String(option.kind).startsWith('allow'))
    const result = allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } }
    state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    return
  }

  record('notification', { engine: state.label, message })
}

function call(state, method, params) {
  const id = state.nextId
  state.nextId += 1
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waiting.delete(id)
      reject(new Error(`timeout after ${TIMEOUT_MS}ms on ${method}`))
    }, TIMEOUT_MS)
    state.waiting.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    const request = { jsonrpc: '2.0', id, method, params }
    record('request', { engine: state.label, message: request })
    state.child.stdin.write(JSON.stringify(request) + '\n')
  })
}

/** What a response was, as one line: the peer's error code and message, or the result's own shape. */
function said(response) {
  if (response?.error !== undefined) {
    return `ERROR code=${response.error.code} message=${response.error.message}`
  }
  return `OK ${JSON.stringify(response?.result ?? null)}`
}

/**
 * The model advertisement a `session/new` result carries, read as the agent wrote it.
 *
 * Three surfaces are looked for, because ACP's own answer to "which models does this agent have" moved and the
 * engines on this machine do not agree on it:
 *
 * - `models.currentModelId` + `models.availableModels[]`, the advertisement OpenCode sends, whose entries
 *   carry `modelId` and a display name.
 * - `models[]`, the flat form, in case an engine sends that instead.
 * - `configOptions[]`, the session-configuration form, whose entry with the category `model` is a `select`
 *   whose `currentValue` is the chosen model and whose `options[].value` are the rest — the same catalogue
 *   under the name the configuration protocol gives it.
 *
 * Neither is required: an engine that advertises nothing is the answer this probe most needs to be able to
 * state, so the absence comes back as a stated absence rather than as a null a caller has to interpret.
 */
function advertisedModels(result) {
  const answer = result ?? {}
  const models = answer.models
  const configOption = modelConfigOption(result)

  if (models === undefined || models === null) {
    return {
      present: answer.model !== undefined || configOption !== null,
      shape: configOption !== null ? 'none (models absent)' : answer.model !== undefined ? 'model' : 'none',
      configOptionShape: configOption === null ? null : describeConfigOption(configOption),
      ids: configOption === null ? [] : configOption.ids.slice(0, MODEL_SAMPLE),
      modelCount: configOption === null ? 0 : configOption.ids.length,
      idsTruncated: configOption !== null && configOption.ids.length > MODEL_SAMPLE && !FULL_MODELS,
    }
  }
  if (Array.isArray(models)) {
    const ids = models.map((entry) => modelIdOf(entry)).filter((id) => id !== null)
    return { present: true, shape: 'models[]', ...sampleOf(ids) }
  }
  const available = models.availableModels
  if (Array.isArray(available)) {
    const ids = available.map((entry) => modelIdOf(entry)).filter((id) => id !== null)
    return {
      present: true,
      shape: 'models.availableModels[]',
      currentModelId: models.currentModelId ?? null,
      ...sampleOf(ids),
    }
  }
  return { present: true, shape: 'models (unrecognised)', ids: [], modelCount: 0 }
}

/** The `configOptions` entry whose category is `model`, or null when the agent declared none. */
function modelConfigOption(result) {
  const options = (result ?? {}).configOptions
  if (!Array.isArray(options)) return null
  return (
    options.find((entry) => {
      const candidate = entry ?? {}
      return candidate.category === 'model' || candidate.id === 'model'
    }) ?? null
  )
}

/** A config option as the summary carries it: the ids a caller would set, plus how the option is named. */
function describeConfigOption(option) {
  const values = (option.options ?? []).map((entry) => (entry ?? {}).value).filter((v) => typeof v === 'string')
  return {
    id: option.id ?? null,
    category: option.category ?? null,
    type: option.type ?? null,
    currentValue: option.currentValue ?? null,
    optionCount: values.length,
    ids: values,
  }
}

/**
 * The ids a log carries: all of them, or the head of the list with the count and a marker saying so.
 *
 * `idsTruncated` is stated rather than implied, so a reader never has to compare a number against a length to
 * find out whether they are looking at the whole catalogue.
 */
function sampleOf(ids) {
  const modelCount = ids.length
  if (FULL_MODELS || modelCount <= MODEL_SAMPLE) return { ids, modelCount, idsTruncated: false }
  return { ids: ids.slice(0, MODEL_SAMPLE), modelCount, idsTruncated: true }
}

/** A model entry's id, whichever of the two spellings the agent used for it. */
function modelIdOf(entry) {
  if (typeof entry === 'string') return entry
  const candidate = entry ?? {}
  for (const key of ['modelId', 'id', 'name']) {
    if (typeof candidate[key] === 'string') return candidate[key]
  }
  return null
}

async function arm(label, spec) {
  const runner = present(spec.bin)
  if (!runner.ok) {
    record('skip', { engine: label, bin: spec.bin, note: 'binary not runnable', reason: runner.reason })
    return { engine: label, skipped: true }
  }

  record('engine-version', { engine: label, bin: spec.bin, text: runner.text })

  // Asked before anything is spawned on the pipe, and recorded for both engines: Kimi's session can be refused
  // outright, and this is then the only model surface on that machine that can still be read.
  const helpLines = helpModelLines(spec.bin)
  record('cli-help-model-lines', { engine: label, count: helpLines.length, lines: helpLines })

  const state = openChild(spec.bin, label)
  const findings = { engine: label, skipped: false }

  try {
    const init = await call(state, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    record('initialize', { engine: label, said: said(init), result: init?.result ?? null })

    const created = await call(state, 'session/new', { cwd: CWD, mcpServers: [] })
    record('session-new', { engine: label, said: said(created), result: withoutCatalogue(created?.result) })

    // A refused `session/new` is the environment rather than the probe: the code, the message and the auth
    // methods the agent offered are kept verbatim, and the arm ends as a stated skip. Nothing downstream is
    // asked, because nothing downstream exists without a session.
    if (created?.error !== undefined) {
      const refusal = created.error ?? {}
      findings.handshake = 'refused'
      findings.refusal = { code: refusal.code ?? null, message: refusal.message ?? '', data: refusal.data ?? null }
      record('session-new-refused', {
        engine: label,
        code: refusal.code ?? null,
        message: refusal.message ?? '',
        authMethods: refusal.data?.authMethods ?? null,
        note: 'the agent created no session, so its model surface cannot be measured on this machine',
      })
      return findings
    }

    const sessionId = created?.result?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      findings.handshake = 'failed'
      record('finding', { engine: label, handshake: 'no sessionId in session/new result' })
      return findings
    }

    findings.handshake = 'ok'
    const models = advertisedModels(created.result)
    findings.modelsPresent = models.present
    findings.modelsShape = models.shape
    findings.modelIds = models.ids
    findings.currentModelId = models.currentModelId ?? null
    findings.configOption = models.configOptionShape ?? null
    record('models-advertised', { engine: label, ...models })

    // The catalogue as the *session config options* name it, when the agent declared one: a caller that sets a
    // model through `session/set_config_option` needs the config id and the values, and both are the agent's
    // own rather than this probe's guess.
    const configOption = modelConfigOption(created.result)
    if (configOption !== null) {
      record('config-option-model', {
        engine: label,
        configId: configOption.id ?? null,
        category: configOption.category ?? null,
        type: configOption.type ?? null,
        currentValue: configOption.currentValue ?? null,
        optionCount: (configOption.options ?? []).length,
        optionSample: (configOption.options ?? []).slice(0, MODEL_SAMPLE),
      })
    }

    // The good id is the agent's own first advertisement when it gave one; when it gave none there is no
    // "known good" to offer, and the call below is made with a value the agent can only refuse — which is the
    // fact worth recording about an engine with no model surface at all.
    const goodId = models.ids[0] ?? null
    const configId = configOption?.id ?? 'model'
    findings.attempts = []

    for (const candidate of CANDIDATE_METHODS) {
      for (const [kind, modelId] of [
        ['good', goodId],
        ['bad', UNKNOWN_MODEL],
      ]) {
        if (kind === 'good' && goodId === null) continue
        let answer
        try {
          answer = await call(state, candidate.method, candidate.params(sessionId, modelId, configId))
        } catch (error) {
          findings.attempts.push({ method: candidate.method, kind, outcome: `THREW ${String(error)}` })
          record('set-model-threw', { engine: label, method: candidate.method, kind, modelId, message: String(error) })
          continue
        }
        const outcome = said(answer)
        // A bad id the agent *accepted* is recorded as such rather than as a refusal: an engine that normalises
        // an unknown model instead of rejecting it has no refusal shape to branch on, and the feature turn has
        // to be told that rather than left to assume a validation exists.
        findings.attempts.push({
          method: candidate.method,
          kind,
          modelId,
          accepted: answer?.error === undefined,
          outcome,
        })
        record('set-model', {
          engine: label,
          method: candidate.method,
          kind,
          modelId,
          said: outcome,
          response: answer,
        })

        // A method this agent does not implement is settled by the agent's own answer, once: nothing is
        // gained by asking the same absent method a second time with the other id.
        if (answer?.error?.code === -32601) break
      }
    }

    findings.badModelRefused = findings.attempts.some((attempt) => attempt.kind === 'bad' && attempt.accepted === false)
  } catch (error) {
    record('arm-threw', { engine: label, message: String(error) })
    findings.threw = String(error)
  } finally {
    state.child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }

  return findings
}

const requested = process.argv.slice(2)
const labels = requested.length > 0 ? requested : Object.keys(ENGINES)

const watchdog = setTimeout(() => {
  record('watchdog', { note: 'the probe exceeded its budget and stopped itself' })
  process.exit(1)
}, 600_000)
watchdog.unref?.()

const results = []
for (const label of labels) {
  const spec = ENGINES[label]
  if (spec === undefined) {
    record('unknown-engine', { engine: label, known: Object.keys(ENGINES) })
    continue
  }
  results.push(await arm(label, spec))
}

const presented = results.filter((result) => !result.skipped)
const measured = presented.filter((result) => result.handshake === 'ok')
const refused = presented.filter((result) => result.handshake === 'refused')
const failed = presented.filter((result) => result.handshake === 'failed' || result.threw !== undefined)

record('summary', {
  results,
  measured: measured.map((result) => ({
    engine: result.engine,
    modelsPresent: result.modelsPresent,
    modelsShape: result.modelsShape,
    currentModelId: result.currentModelId,
    badModelRefused: result.badModelRefused ?? null,
  })),
  refusedByEnvironment: refused.map((result) => ({ engine: result.engine, ...result.refusal })),
  failures: failed.map((result) => ({ engine: result.engine, threw: result.threw ?? null })),
})

if (failed.length > 0) {
  process.stdout.write(`acp-model-surface-probe: FAILED (${failed.map((f) => f.engine).join(', ')})\n`)
  process.exit(1)
}
if (presented.length === 0) {
  process.stdout.write('acp-model-surface-probe: SKIPPED (no engine binary)\n')
  process.exit(0)
}
const skipped = results.filter((result) => result.skipped).map((result) => result.engine)
const parts = [
  `measured ${measured.map((r) => r.engine).join(', ') || 'none'}`,
  ...(refused.length > 0 ? [`refused by the environment ${refused.map((r) => r.engine).join(', ')}`] : []),
  ...(skipped.length > 0 ? [`not installed ${skipped.join(', ')}`] : []),
]
process.stdout.write(`acp-model-surface-probe: ok (${parts.join('; ')})\n`)
process.exit(0)
