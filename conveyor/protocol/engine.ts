/**
 * The spawn law, and the engine picker's rows.
 *
 * Every engine the app will ever run is spawned by main, through this law and nothing else: the binary
 * comes from this file's allowlist or from a settings override that still names an allowlisted binary, the
 * arguments are an array the caller wrote, and `shell` is stated as `false` rather than left to a caller
 * to remember. A refusal is a code, never a sentence, because the branch belongs to whoever asked.
 *
 * It is a rule rather than a module because it has to be provable without starting anything: `resolve`
 * answers from its tables and its argument, so a suite can hold every refusal still. The spawning itself —
 * the version probe — lives beside it in `conveyor/modules/engine.ts`, where a process may be started.
 *
 * The law imports nothing, deliberately. An import of `path` would be the first step toward a platform
 * rule living in a second place, and an import of a store or a module would be an input the law could
 * consult. Its whole answer is derived from what it is handed, which is what makes the suite that reads
 * this file's own source for imports a statement about purity rather than about taste.
 */

/**
 * The engines this build may run, as ids.
 *
 * Two, this phase: Codex, whose non-interactive surface is a JSONL stream, and Kimi, whose installed CLI
 * answers with an ACP server. The list is the allowlist: an id absent here is refused by `resolveEngineSpawn`
 * whatever a payload claims, so adding an engine is a change to this line and to the tables below it
 * rather than a change to a caller.
 */
export const ENGINE_IDS = ['codex', 'kimi'] as const

export type EngineId = (typeof ENGINE_IDS)[number]

/** What a row is drawn as. The label is the app's, not the binary's. */
export const ENGINE_LABELS: Readonly<Record<EngineId, string>> = {
  codex: 'ChatGPT (Codex)',
  kimi: 'Kimi (Moonshot)',
}

/**
 * What an engine is called where the word "via" precedes it, in a transcript marker.
 *
 * A second name rather than the picker's, because the two sentences are not the same sentence: a picker row is
 * naming the product a user is choosing, and a marker under a tool call is saying which engine ran it — where
 * the short name is what a reader scans for. The picker's label is the fallback for an engine this table has no
 * short name for, so an engine added later is drawn as itself rather than as nothing.
 */
export const ENGINE_MARKER_LABELS: Readonly<Record<EngineId, string>> = { codex: 'Codex', kimi: 'Kimi' }

/**
 * The three sandbox values the CLI traces, strictest first.
 *
 * They are the CLI's own names, quoted rather than invented, because this is the one place a user's choice
 * becomes a word an OS is handed: a mode spelled differently here would be a flag the engine refuses or,
 * worse, silently reads as its default. The order is stated so a control can offer them from the strictest
 * to the loosest, which is the order they are reasoned about in.
 */
export const ENGINE_PERMISSION_MODE_IDS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type EnginePermissionMode = (typeof ENGINE_PERMISSION_MODE_IDS)[number]

/**
 * The mode an engine runs under until a user chooses otherwise.
 *
 * `workspace-write`, which confines writes to the folder the conversation is rooted in. It is the default
 * because it is the strictest mode that still lets an engine do the work it was asked for: `read-only`
 * cannot answer half of what a user asks, and `danger-full-access` is a grant nobody should receive by
 * not saying anything. A default is what a user gets without choosing, so it has to be the mode that
 * needs no warning — the other two are chosen, and one of them is chosen carefully.
 */
export const ENGINE_DEFAULT_PERMISSION_MODE: EnginePermissionMode = 'workspace-write'

/**
 * What each mode is called where a user chooses it.
 *
 * The CLI's own word is the flag, not the name: `danger-full-access` is what the OS is handed and
 * `Full access` is what the control says, because a label is read by a person and a flag is read by a
 * binary. The two are held together rather than derived, so renaming the control cannot rename the flag.
 */
export const ENGINE_PERMISSION_MODE_LABELS: Readonly<Record<EnginePermissionMode, string>> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

/**
 * What the section says beside a mode, or `null` when it has nothing to add.
 *
 * Only the mode that grants more than the default carries words, and they name what it grants rather than
 * that it is dangerous: "full machine access" is a fact a user can weigh, and "are you sure?" is not. A
 * warning attached to every mode would be a warning nobody reads on the one that matters.
 */
export const ENGINE_PERMISSION_MODE_WARNINGS: Readonly<Record<EnginePermissionMode, string | null>> = {
  'read-only': null,
  'workspace-write': null,
  'danger-full-access': 'Full machine access: the engine may write anywhere you can, and will not stop to ask.',
}

/**
 * The mode each engine runs under when nobody has chosen one.
 *
 * Per engine rather than one global default, because the trace settled the modes against the `exec` stream
 * of a particular CLI: a second engine joins with its own answer here rather than inheriting this one's.
 * The declaration above is what every entry starts from, so a mode's default is stated once.
 */
export const ENGINE_PERMISSION_MODES: Readonly<Record<EngineId, EnginePermissionMode>> = {
  codex: ENGINE_DEFAULT_PERMISSION_MODE,
  // Kimi's traced CLI offers no sandbox flag — `kimi acp` takes no arguments at all — so this value is the
  // mode its row starts on rather than a value a flag is ever built from: its consent surface is the
  // per-call question the ACP stream asks, answered through the shield.
  kimi: ENGINE_DEFAULT_PERMISSION_MODE,
}

/**
 * Whether a value is one of the traced modes.
 *
 * The boundary's guard, and deliberately not a cast: a mode arrives from a settings file, a select's string
 * or a schema, and the answer to "is this a mode" is the only thing that may stand between an unknown
 * string and the flag an OS is handed.
 */
export function isEnginePermissionMode(value: unknown): value is EnginePermissionMode {
  return typeof value === 'string' && (ENGINE_PERMISSION_MODE_IDS as readonly string[]).includes(value)
}

/**
 * The mode to run under, from whatever was stored for an engine.
 *
 * The one place a stored value becomes a mode, so the store, the section and the turn cannot each decide
 * separately what to do about a file that names something no rule offers: it is the engine's own default,
 * never the unknown string, because passing one through would be handing a settings file the flag.
 */
export function enginePermissionMode(value: unknown, engineId?: string): EnginePermissionMode {
  if (isEnginePermissionMode(value)) return value
  const byEngine = engineId === undefined ? undefined : ENGINE_PERMISSION_MODES[engineId as EngineId]
  return byEngine ?? ENGINE_DEFAULT_PERMISSION_MODE
}

/**
 * The line a section shows about how an engine is signed in to.
 *
 * One sentence per engine because there is no shared answer: this app never sees a credential, and each
 * CLI signs itself in by its own means. For Codex that means the CLI's own login, through the account the
 * user already has — which is what this says so that a user staring at a not-installed engine knows what
 * the next step is. A second engine states its own; an engine with no line is an engine added without one.
 */
export const ENGINE_AUTH_HINTS: Readonly<Record<EngineId, string>> = {
  codex: 'Sign in with your ChatGPT account through the CLI\u2019s own login.',
  kimi: 'Sign in with your Kimi account through the CLI\u2019s own login.',
}

/**
 * The arguments a conversation with an engine is started with, before anything the turn adds.
 *
 * An array, held here rather than written at the call site, so the words a user reads in this repo are the
 * words the OS is handed. `exec --json` is the dialect the mapper reads and the probe proved is the CLI's own
 * first-party non-interactive surface. `--sandbox` carries the permission mode above, and it is what stands in
 * for the consent the stream cannot ask for: the value in the template is the default, and
 * `engineLaunchArgs` is the one rule that replaces it with a chosen mode. `--skip-git-repo-check` is there
 * because a folder a user opens in this app is not necessarily a repository, and the CLI refuses to run in
 * one — the flag relaxes that one requirement and nothing else.
 */
export const ENGINE_LAUNCH_ARGS: Readonly<Record<EngineId, readonly string[]>> = {
  codex: ['exec', '--json', '--sandbox', ENGINE_DEFAULT_PERMISSION_MODE, '--skip-git-repo-check'],
  // `acp` and nothing else. The CLI's own `--help` names this subcommand as its ACP server and its older
  // `--acp` flag as deprecated in its favour; `kimi acp --help` offers no option at all, so no mode, no
  // directory and no prompt can be added to it. The prompt travels as a `session/prompt` on the pipe.
  kimi: ['acp'],
}

/**
 * How an engine's stdin is treated, as a law rather than as each caller's habit.
 *
 * The Phase 70 lesson, stated where it can be read: a `codex exec` whose stdin is a pipe appends that pipe to
 * its prompt and waits for it to end, so an engine spawned that way never answers and never ends — its dialect
 * is a command line the prompt travels in, and its stdin is `ignored` because nothing will ever be written to
 * it. An ACP agent is the other shape entirely: the pipe *is* the transport, the handshake and every later
 * message travel on it, and a client that closed it would have nothing left to speak through — so it is
 * `transport-open`.
 *
 * A table rather than a habit of each caller, because it is the property the turn is routed by: the turn below
 * picks its runner from this value, so a launch config cannot be authored without stating which of the two it
 * is — and the two runners cannot be handed the same engine by accident.
 */
export type EngineStdinPolicy = 'transport-open' | 'ignored'

export const ENGINE_STDIN_POLICIES: Readonly<Record<EngineId, EngineStdinPolicy>> = {
  codex: 'ignored',
  kimi: 'transport-open',
}

/**
 * The stdin policy of one engine, or the closed one for an id this build does not ship.
 *
 * `ignored` as the answer to an unknown id, deliberately: of the two, that is the one whose worst case is a
 * process with nothing to wait for. An id that is not an engine is refused by the law long before a process
 * exists.
 */
export function engineStdinPolicy(engineId: string): EngineStdinPolicy {
  return ENGINE_STDIN_POLICIES[engineId as EngineId] ?? 'ignored'
}

/**
 * The arguments a turn runs with, under one permission mode.
 *
 * The shipped array above is the template and this is the one rule that shapes it: the value after
 * `--sandbox` becomes the chosen mode, so the choice a user made is the flag the OS is handed rather than a
 * preference the turn happens to read. Nothing else in the array moves, which is what makes this a
 * substitution and not a second launch config: a mode cannot add a flag, and an engine's own dialect is
 * stated once, above.
 *
 * A mode no rule offers — a settings file that names one, a select that somehow handed back a stale string —
 * is answered with the default rather than passed through. `read-only` and `danger-full-access` are both fine
 * to hand over; the thing that must never be handed over is a word nobody traced, because the CLI's answer to
 * an unknown sandbox value is its own business and not something this app can bound.
 */
export function engineLaunchArgs(engineId: EngineId, mode?: unknown): string[] {
  const args = [...(ENGINE_LAUNCH_ARGS[engineId] ?? [])]
  const at = args.indexOf('--sandbox')
  if (at >= 0) args[at + 1] = enginePermissionMode(mode, engineId)
  return args
}

/**
 * Where each engine is installed on a machine whose `PATH` does not carry it.
 *
 * A template rather than a path: the real location is `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, and the
 * `<hash>` is a build id this app may not know and must not guess — it changes when the CLI updates itself. The
 * `*` is therefore one path segment, resolved by reading the directory in main, where a directory may be read.
 * The law stays free of it: nothing here expands anything, and `resolveEngineSpawn` still judges the absolute
 * path a caller hands it by the name of the file at the end of it.
 */
export interface EngineInstallPattern {
  /** A directory, percent-tokens and at most one `*` segment wide. */
  dir: string
  /** The binary's name inside it, without a launchable extension. */
  binary: string
}

export const ENGINE_INSTALL_PATTERNS: Readonly<Record<EngineId, readonly EngineInstallPattern[]>> = {
  codex: [{ dir: '%LOCALAPPDATA%/OpenAI/Codex/bin/*', binary: 'codex' }],
  // Where the CLI installs itself for one user, and where this machine's probe found it: `.local/bin` under
  // the profile, holding `kimi.exe`. Unlike Codex's there is no build-id segment to read, so the template is
  // one path and the probe's check of it is a `stat` rather than a directory listing.
  kimi: [{ dir: '%USERPROFILE%/.local/bin', binary: 'kimi' }],
}

/**
 * Expand the percent-tokens an install template may carry, or answer `null`.
 *
 * Null rather than a half-expanded string, and rather than a guess: a machine with no `LOCALAPPDATA` is a machine
 * where this pattern names nothing, and a caller handed `%LOCALAPPDATA%/...` back would go looking for a
 * directory whose name is that sentence. The separator is normalised to `/` so the rest of this app never has to
 * ask which platform wrote the template; joining it to a real path is the caller's job, in main, where `path` is
 * allowed to live.
 */
export function expandInstallDir(dir: string, env: Readonly<Record<string, string | undefined>>): string | null {
  let expanded = dir.replace(/\\/g, '/')
  const tokens = expanded.match(/%([A-Za-z_][A-Za-z0-9_]*)%/g) ?? []

  for (const token of tokens) {
    const value = env[token.slice(1, -1)]
    if (value === undefined || value === '') return null
    expanded = expanded.split(token).join(value.replace(/\\/g, '/'))
  }

  return expanded
}

/**
 * The app's own row, as a select value.
 *
 * Not an engine id and never stored: a conversation that runs the Sam loop carries no engine key at all, so
 * this exists only because a select needs a value for the row that means "none" — and an empty string is
 * reserved by the primitive rather than available for the purpose. It is what the picker turns back into
 * `null` on the way out, which is the only form the record ever sees.
 */
export const SAM_ENGINE_VALUE = 'agent-sam'

/** The app's own row's name, drawn first in the picker because it is what a conversation with no engine runs. */
export const AGENT_SAM_ENGINE_NAME = 'Agent Sam'

/**
 * The binary each engine is run by — the name, resolved on `PATH` by the OS.
 *
 * A name rather than a path: where a binary lives is the machine's answer, and a path baked in here
 * would be wrong on the next machine and stale on this one. The settings override exists for the machine
 * whose binary is somewhere `PATH` does not cover, and it is judged by the file it names rather than
 * trusted for being the user's.
 */
export const ENGINE_BINARIES: Readonly<Record<EngineId, string>> = { codex: 'codex', kimi: 'kimi' }

/** The argument that makes a binary say its version, and nothing else. */
export const ENGINE_PROBE_ARGS: readonly string[] = ['--version']

/** What a row says when the probe found nothing, in the words a user reads rather than a code. */
export const ENGINE_NOT_INSTALLED_NOTE = 'Not installed'

/**
 * Every way the law can refuse, as codes.
 *
 * Distinct rather than one `ENGINE_REFUSED` because the caller's answer differs: an unknown id is a
 * programming mistake, a non-array is a bug in the caller's own construction, a shell is a request this
 * app does not honour, an unallowed binary is a settings file naming something it may not, and a missing
 * binary is a state the picker draws. A sentence would collapse all five into something nobody can branch
 * on — which is why the message never travels and the code always does.
 */
export const ENGINE_SPAWN_CODES = {
  ENGINE_UNKNOWN: 'ENGINE_UNKNOWN',
  ENGINE_ARGS_NOT_ARRAY: 'ENGINE_ARGS_NOT_ARRAY',
  ENGINE_ARGS_NOT_STRINGS: 'ENGINE_ARGS_NOT_STRINGS',
  ENGINE_SHELL_REFUSED: 'ENGINE_SHELL_REFUSED',
  ENGINE_BINARY_NOT_ALLOWED: 'ENGINE_BINARY_NOT_ALLOWED',
  ENGINE_NOT_INSTALLED: 'ENGINE_NOT_INSTALLED',
  ENGINE_VERSION_UNREADABLE: 'ENGINE_VERSION_UNREADABLE',
  ENGINE_SPAWN_FAILED: 'ENGINE_SPAWN_FAILED',
  /** A binary that started and then said nothing within the probe's budget. */
  ENGINE_PROBE_TIMEOUT: 'ENGINE_PROBE_TIMEOUT',
} as const

export type EngineSpawnCode = (typeof ENGINE_SPAWN_CODES)[keyof typeof ENGINE_SPAWN_CODES]

/**
 * What a refused path is said as, one line per code.
 *
 * A path override is the one setting in this app whose failure a user has to act on — the field they just
 * typed into is not going to be saved, and "an error occurred" would leave them re-typing the same thing. So
 * each code a probe can answer with gets a sentence naming what the machine said, and the section draws the
 * one its refusal carried: the branch is on the code, the words are looked up, and no caller ever reads a
 * message. Every code in the spawn set has an entry, including the ones a path save cannot produce — a
 * missing word would be a silent failure on the day one of them can.
 */
export const ENGINE_PATH_REFUSAL_WORDS: Readonly<Record<EngineSpawnCode, string>> = {
  ENGINE_UNKNOWN: 'That is not an engine this build can run.',
  ENGINE_ARGS_NOT_ARRAY: 'The probe arguments were not handed over as a list.',
  ENGINE_ARGS_NOT_STRINGS: 'The probe arguments were not a list of words.',
  ENGINE_SHELL_REFUSED: 'This app never starts an engine through a shell.',
  ENGINE_BINARY_NOT_ALLOWED: 'That file is not the engine binary this app runs.',
  ENGINE_NOT_INSTALLED: 'Nothing is installed at that path.',
  ENGINE_VERSION_UNREADABLE: 'That binary answered something this app could not read as a version.',
  ENGINE_SPAWN_FAILED: 'That binary could not be started.',
  ENGINE_PROBE_TIMEOUT: 'That binary did not answer in time.',
}

/**
 * The sentence for a refusal, from its code.
 *
 * The code is what a caller branches on; this is what a reader sees. A code with no words — one added to the
 * spawn set by a later phase and not here — is answered with a sentence about the save rather than with the
 * code itself, because a user reading `ENGINE_SOMETHING` has been told nothing they can use.
 */
export function enginePathRefusalWord(code: string): string {
  return ENGINE_PATH_REFUSAL_WORDS[code as EngineSpawnCode] ?? 'That path was not saved.'
}

/**
 * The one way a consent question is refused before it is ever put.
 *
 * Its own set rather than a member of the spawn codes, because it is not about spawning: the engine is
 * running and asking, and what is missing is somebody to ask. The bridge answers with this when no window
 * exists, and the ACP client turns that into a `cancelled` outcome — an engine is never told the user
 * refused something the user never saw.
 */
export const ENGINE_CONSENT_CODES = {
  ENGINE_CONSENT_UNANSWERED: 'ENGINE_CONSENT_UNANSWERED',
} as const

export type EngineConsentCode = (typeof ENGINE_CONSENT_CODES)[keyof typeof ENGINE_CONSENT_CODES]

/** What a caller asks the law for. `args` and `shell` are `unknown` on purpose: they are untrusted. */
export interface EngineSpawnRequest {
  engineId: string
  args: unknown
  shell?: unknown
  /** An absolute path to the allowlisted binary, from settings. Absent means the name, on `PATH`. */
  binaryOverride?: string
  /** The engines this call may resolve, when a caller brings its own. The shipped law is the default. */
  allowlist?: Readonly<Record<string, string>>
}

/** The law's answer: what to run, or why it will not. */
export type EngineSpawnResolution =
  { ok: true; command: string; args: string[]; shell: false } | { ok: false; code: EngineSpawnCode }

/** Whether a value names an engine this build may run. */
export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value)
}

/**
 * The last segment of a path, without a launchable extension.
 *
 * Written out rather than imported, and split on both separators rather than on the one this platform
 * uses: a settings file can carry either, and a law that read `C:\Tools\codex\codex.exe` as one segment
 * would refuse a binary it sanctions. `.exe` and `.cmd` are stripped because those are how a binary is
 * named on the one platform that needs them; a bare name is stripped of nothing.
 */
function binaryNameOf(target: string): string {
  const segments = target.split(/[\\/]/)
  const last = segments[segments.length - 1] ?? ''
  return last.replace(/\.(exe|cmd|bat)$/i, '')
}

/**
 * Resolve what may be run, or refuse with the code that says why.
 *
 * The order of the checks is the order of the arguments' trustworthiness: the engine id first, because a
 * refused id means nothing else about the call is worth reading; the argument shape next, because a
 * string where an array belongs is the injection this law exists to prevent; the shell flag third, and
 * refused rather than overridden, because a caller asking for one is asking for the arguments below to be
 * interpreted by a shell; and the binary last, because it is the only input a settings file may reach.
 */
export function resolveEngineSpawn(request: EngineSpawnRequest): EngineSpawnResolution {
  const allowlist = request.allowlist ?? ENGINE_BINARIES
  const allowed = Object.prototype.hasOwnProperty.call(allowlist, request.engineId)
    ? allowlist[request.engineId]
    : undefined

  if (!allowed) return { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_UNKNOWN }

  if (!Array.isArray(request.args)) return { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_ARGS_NOT_ARRAY }
  const args = request.args as unknown[]
  if (args.some((arg) => typeof arg !== 'string')) {
    return { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_ARGS_NOT_STRINGS }
  }

  if (request.shell === true) return { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_SHELL_REFUSED }

  const override = request.binaryOverride
  if (override !== undefined && binaryNameOf(override) !== allowed) {
    return { ok: false, code: ENGINE_SPAWN_CODES.ENGINE_BINARY_NOT_ALLOWED }
  }

  return {
    ok: true,
    command: override ?? allowed,
    args: args as string[],
    // Stated rather than omitted. `shell` is false whenever it is absent, but a caller that forgot it and
    // a caller that meant it would look the same on the page — and only one of them is safe.
    shell: false,
  }
}

/**
 * The version in whatever a binary printed, or `null` when there is none.
 *
 * The first token that is a number with at least one dot — and the rest of it, prerelease suffixes and
 * all, because `0.154.0-alpha.6.2` is the version the CLI reports and a rule that answered `0.154.0`
 * would be a rule that made one up. A leading `v` is a spelling of the name, not part of the number.
 * Prose answers `null` rather than the nearest digits: the caller has a code for "it answered something I
 * cannot read", and reaching it is the honest outcome.
 */
export function engineVersion(output: string): string | null {
  for (const token of output.split(/\s+/)) {
    const candidate = token.replace(/^v/, '')
    if (/^\d+(\.\d+)+([-.][0-9A-Za-z.-]+)?$/.test(candidate)) return candidate
  }
  return null
}

/** What a probe found, or which way it failed. */
export interface EngineProbe {
  installed: boolean
  version?: string
  code?: EngineSpawnCode
}

/** One row of the engine picker, as the renderer draws it. */
export interface EngineRow {
  /** The engine's id, or `null` for the app's own row — which names no engine, by construction. */
  id: string | null
  name: string
  installed: boolean
  version: string | null
  /** What the row has to say about itself, or `null` when there is nothing to say. */
  note: string | null
}

/**
 * One engine question, as it crosses to the shield.
 *
 * Flat, and all strings: it travels to a store every window mirrors, and what the card needs is what is in it
 * — which engine is asking, which call it is about, what the call is, and the options the agent offered. The
 * option kinds travel too, because whether an option grants consent is decided by the kind and never by the
 * label an engine wrote.
 *
 * Lives here rather than beside the bridge that fills it, because two processes need the shape: main
 * dispatches it, the renderer reads it, and a type that only main could name would make the renderer import
 * a module that starts processes. The option shape is written out rather than imported from the ACP protocol
 * for the same reason this file has no imports at all.
 */
export interface PendingEngineConsent {
  requestId: string
  engineId: string
  engineName: string
  toolCallId: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}

/**
 * The picker's rows: the app itself first, then every allowlisted engine.
 *
 * The app's row is not a member of the allowlist and never will be: a conversation that names no engine
 * runs the Sam loop, which is what every conversation written before engines existed does. An engine
 * nobody has probed is drawn as not installed rather than dropped — a row that disappeared until it was
 * detected would be an engine the user cannot find and cannot be told about.
 */
export function engineRows(probes: Partial<Record<string, EngineProbe>>): EngineRow[] {
  const sam: EngineRow = {
    id: null,
    name: AGENT_SAM_ENGINE_NAME,
    installed: true,
    version: null,
    note: null,
  }

  const engines = ENGINE_IDS.map((id): EngineRow => {
    const probe = probes[id]
    const installed = probe?.installed === true
    return {
      id,
      name: ENGINE_LABELS[id],
      installed,
      version: installed && probe?.version !== undefined ? probe.version : null,
      note: installed ? null : ENGINE_NOT_INSTALLED_NOTE,
    }
  })

  return [sam, ...engines]
}

/**
 * What an engine is called in a sentence, for the copy that has to name the one a conversation runs as.
 *
 * The release's own label first, and then the raw id: a conversation created under an engine this build no
 * longer ships still has that id on its record, and showing the id is the truthful reading of it — inventing
 * a name for an engine nobody can name would be inventing one. `null` is the app's own row, which is a name
 * like any other here because the sentence it lands in has to read as one.
 */
export function engineLabel(engineId: string | null): string {
  if (engineId === null) return AGENT_SAM_ENGINE_NAME
  return ENGINE_LABELS[engineId as EngineId] ?? engineId
}

/**
 * What an engine is called in a transcript marker, after the word "via".
 *
 * The short name where one exists, and the picker's label otherwise, for the reason the two tables are separate:
 * a marker is a glance, and an engine this build cannot name shortly is still an engine whose name is known. An
 * id in neither table is answered as itself rather than as nothing, so a release that drops an engine's name
 * still marks its calls with the id the conversation carries.
 */
export function engineMarkerLabel(engineId: string): string {
  return ENGINE_MARKER_LABELS[engineId as EngineId] ?? ENGINE_LABELS[engineId as EngineId] ?? engineId
}

/**
 * One engine's stored preferences, as this app reads them.
 *
 * Both fields together, because they are one record per engine and a caller that asked for one of them would
 * have to ask the same question about defaults twice. `binaryPath` is `null` — never an empty string — when
 * there is no override: the allowlist is the answer then, and a blank path is not a location.
 */
export interface EnginePreference {
  binaryPath: string | null
  permissionMode: EnginePermissionMode
}

/**
 * A record as it arrives from a settings file, before anything has read it.
 *
 * `unknown` on both fields, deliberately: this is the persisted-file boundary, and a file is untrusted input
 * like any other. Narrowing happens once, below, rather than at each of the three places a reader asks — so
 * the section, the probe and the turn cannot each decide separately what to do about a mode nobody offers.
 */
export interface StoredEnginePreference {
  binaryPath?: unknown
  permissionMode?: unknown
}

/**
 * The preference record for one engine, filled in from the shipped defaults.
 *
 * The store holds what a user set and nothing else, so this is where an engine nobody has touched, a record
 * read off a file that named one field, and a file naming a mode no rule offers all become the same honest
 * shape. Defaults rather than omissions, because every reader downstream — the section, the probe, the turn —
 * should get a mode to run under without having to know what "absent" means.
 */
export function enginePreference(record: StoredEnginePreference | undefined, engineId: EngineId): EnginePreference {
  const path = typeof record?.binaryPath === 'string' ? record.binaryPath.trim() : ''
  return {
    binaryPath: path === '' ? null : path,
    permissionMode: enginePermissionMode(record?.permissionMode, engineId),
  }
}

/** The law's answer about where an engine's binary comes from. */
export type EnginePathResolution =
  { ok: true; path: string | null; source: 'override' | 'allowlist' } | { ok: false; code: EngineSpawnCode }

/**
 * Resolve which binary an engine runs by, in the order a settings override introduces.
 *
 * The order is the whole rule, and it is stated in one place so a store, a probe and a save cannot each hold
 * a different version of it:
 *
 * - an override that is set wins over the allowlist, because it is the user's own answer about this machine;
 * - the probe gates that override, so a path is only ever used after something has run it — "set" is not
 *   "works";
 * - an override that is absent — or one emptied back to blank — leaves the allowlist exactly as it was, which
 *   is what makes this phase's addition invisible to a user who never opens the field.
 *
 * The refusal is the *probe's* code and never a new one of this rule's own: a path nothing is at and a path
 * naming something that is not this engine are different answers, and collapsing them into "the override was
 * refused" would make the section unable to say which happened. A path with no probe behind it at all is
 * refused as not installed, because nothing has been proven about it.
 */
export function resolveEnginePathOverride(input: {
  override?: string | null
  probe?: EngineProbe
}): EnginePathResolution {
  const override = typeof input.override === 'string' ? input.override.trim() : ''
  if (override === '') return { ok: true, path: null, source: 'allowlist' }

  const probe = input.probe
  if (probe === undefined || probe.installed !== true) {
    return { ok: false, code: probe?.code ?? ENGINE_SPAWN_CODES.ENGINE_NOT_INSTALLED }
  }

  return { ok: true, path: override, source: 'override' }
}
