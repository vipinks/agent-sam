import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, command, query } from '../init'
import { resolveWindow } from '../protocol/context-window'
import type { CustomProvider } from '../protocol/custom-provider'
import {
  MAX_COMBO_MEMBERS,
  appendComboMember,
  comboMemberKnown,
  comboSchema,
  moveComboMember,
  newComboId,
  removeComboMember,
  sameComboMember,
  type Combo,
  type ComboMember,
  type ComboRegistryEntry,
  type ComboRegistrySnapshot,
} from '../protocol/combos'

/**
 * Model combos — the file, the rules that refuse a change, and the registry the resolvers read.
 *
 * The store beside this module is the mirror; this is the writer. Every mutation reads the file
 * first, applies the rule to what the file actually says, writes it atomically, and only then
 * dispatches the new list — so a command that failed leaves the store exactly as the disk has it
 * rather than as the caller wished it. Conveyor's own `persist: true` would have written the store
 * and swallowed the failure, which is why the store is deliberately not persisted that way and
 * `COMBO_IO_ERROR` can be raised here.
 *
 * Commands are serialized through one in-process promise chain. Two windows editing at once would
 * otherwise read the same list, each write its own version, and lose the other's change — the classic
 * lost update — and the chain is cheaper than a lock because main is the only process that writes.
 */

/** Where the file lives: beside every other conveyor store, under this app's userData. */
const COMBO_FILE = ['conveyor-stores', 'combos.json']

/** Codes this module can raise, so callers branch on them rather than on wording. */
export const COMBO_CODES = [
  'COMBO_NOT_FOUND',
  'COMBO_ID_TAKEN',
  'COMBO_EMPTY',
  'COMBO_MEMBER_UNKNOWN',
  'COMBO_LIMIT',
  'COMBO_IO_ERROR',
] as const

export type ComboCode = (typeof COMBO_CODES)[number]

/** The path of the combos file. Never a hardcoded absolute path — always this app's userData. */
export function combosFilePath(): string {
  return join(app.getPath('userData'), ...COMBO_FILE)
}

/** What the file carries. A record rather than a bare array, so a later key has somewhere to live. */
const combosFileSchema = z.object({ combos: z.array(comboSchema) })

function ioError(reason: string): ConveyorError {
  return new ConveyorError('COMBO_IO_ERROR', `Could not read or write combos. ${reason}`)
}

// ---------------------------------------------------------------- the in-memory mirror

/**
 * The list the last successful read produced.
 *
 * The query answers from here rather than from the store, because the module owns the file and the
 * store is a broadcast target: a read that answered from the mirror could disagree with the disk
 * after a failed write. Every successful read and write replaces it.
 */
let cache: Combo[] = []

/**
 * The failure the last load hit, when it hit one.
 *
 * Held rather than thrown from the boot path: the load runs during router setup, and a corrupt file
 * must not stop the app from starting. The first query or command after it reports the failure, and
 * a later successful read clears it — which is what makes "not overwritten until a read succeeds"
 * true rather than a promise.
 */
let loadError: ConveyorError | null = null

/** Whether the initial load has run. A query before it must not answer "empty". */
let loaded = false

/** Installed by the router: mirrors a list to every window. */
let combosSink: ((combos: Combo[]) => void) | null = null

export function setCombosSink(next: ((combos: Combo[]) => void) | null): void {
  combosSink = next
}

/** Dispatch the list to the store, and to whichever windows are listening. */
function publish(combos: Combo[]): void {
  cache = combos
  combosSink?.(combos)
}

// ---------------------------------------------------------------- the registry sink

/**
 * The one reader of what a combo may name and what a request may run against.
 *
 * Installed from `router.ts` after `createRouter`, the pattern `setCustomProviderIds` and
 * `setEnginePreferenceSource` follow: the stores do not exist until the router has returned, and this
 * module is imported *by* the router, so reaching back for it here would close the cycle.
 *
 * One sink with two readers, deliberately: the member guard asks "does the registry know this pair",
 * and the walk asks "may this pair serve this request". Two snapshots would be two answers to one
 * question, and the guard could accept a member the walk then cannot name.
 */
let comboRegistrySource: () => ComboRegistrySnapshot = () => ({ providers: [] })

export function setComboRegistrySource(source: () => ComboRegistrySnapshot): void {
  comboRegistrySource = source
}

/** The snapshot as it stands. Frozen, so a reader cannot edit the registry through it. */
export function currentComboRegistry(): ComboRegistrySnapshot {
  const snapshot = comboRegistrySource()
  return Object.freeze({
    providers: Object.freeze(snapshot.providers.map((entry) => freezeEntry(entry))),
  }) as ComboRegistrySnapshot
}

/**
 * One entry, frozen.
 *
 * The arrays and maps are copied as well as frozen: a snapshot handed to a caller is a fact about the
 * moment it was read, and a caller that mutated the store's arrays afterwards would otherwise change
 * a resolution already in flight.
 */
function freezeEntry(entry: ComboRegistryEntry): ComboRegistryEntry {
  return Object.freeze({
    ...entry,
    enabledModels: Object.freeze([...entry.enabledModels]),
    fetchedModels: Object.freeze([...entry.fetchedModels]),
    defaultModels: Object.freeze([...entry.defaultModels]),
    modelWindows: Object.freeze({ ...entry.modelWindows }),
    windows: Object.freeze({ ...entry.windows }),
  }) as ComboRegistryEntry
}

/**
 * Build the snapshot the sink returns.
 *
 * Pure over its inputs, and here rather than in the router so a suite can build one without an
 * electron app: the router is the caller, not the rule. Every known model's window is resolved once,
 * by `resolveWindow`, so the eligibility filter asks a map rather than re-deriving the three layers.
 */
export function buildComboRegistrySnapshot(input: {
  providers: readonly { id: string; name: string }[]
  custom: readonly CustomProvider[]
  defaults: Record<string, readonly { id: string }[]>
  configs: Record<
    string,
    {
      enabledModels: readonly string[]
      fetchedModels: readonly { id: string }[]
      supportsImages?: boolean
      modelWindows?: Record<string, { contextWindow?: number }>
    }
  >
  configured: readonly string[]
}): ComboRegistrySnapshot {
  const entries: ComboRegistryEntry[] = []

  const add = (
    provider: { id: string; name: string },
    kind: 'built-in' | 'custom',
    models: { enabled: readonly string[]; fetched: readonly string[]; defaults: readonly string[] },
    descriptor?: unknown
  ) => {
    const config = input.configs[provider.id]
    const modelWindows = config?.modelWindows ?? {}
    const known = [...new Set([...models.enabled, ...models.fetched, ...models.defaults])]
    const windows: Record<string, number> = {}
    for (const model of known) {
      const window = resolveWindow({ model, modelWindows })
      if (window !== null) windows[model] = window
    }
    entries.push({
      id: provider.id,
      name: provider.name,
      kind,
      enabledModels: models.enabled,
      fetchedModels: models.fetched,
      defaultModels: models.defaults,
      supportsImages: config?.supportsImages === true,
      modelWindows,
      windows,
      hasKey: input.configured.includes(provider.id),
      ...(descriptor === undefined ? {} : { descriptor }),
    })
  }

  for (const provider of input.providers) {
    const config = input.configs[provider.id]
    add(provider, 'built-in', {
      enabled: config?.enabledModels ?? [],
      fetched: (config?.fetchedModels ?? []).map((model) => model.id),
      defaults: (input.defaults[provider.id] ?? []).map((model) => model.id),
    })
  }

  for (const provider of input.custom) {
    const config = input.configs[provider.id]
    add(
      provider,
      'custom',
      {
        enabled: config?.enabledModels ?? [],
        // A custom provider's catalogue is its descriptor's `models`, and the store's fetched list is
        // the same fact for a provider whose box has been opened. Both are known models.
        fetched: [...new Set([...provider.models, ...(config?.fetchedModels ?? []).map((model) => model.id)])],
        defaults: [],
      },
      {
        ...provider,
        models: [...provider.models],
      }
    )
  }

  return Object.freeze({ providers: Object.freeze(entries) }) as ComboRegistrySnapshot
}

// ---------------------------------------------------------------- the file

/** Parse the file's bytes into the list, or throw `COMBO_IO_ERROR`. */
function parseCombos(raw: string): Combo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw ioError(err instanceof Error ? err.message : String(err))
  }
  const result = combosFileSchema.safeParse(parsed)
  if (!result.success) throw ioError('The combos file is not in a shape this build understands.')
  return result.data.combos
}

/**
 * The initial load, run synchronously during router setup.
 *
 * Synchronous on purpose: `router.ts` is a module body, and this is the one moment before any window
 * exists. An async load would let the first window query an empty store and write it back, which is
 * exactly the data loss the ordering exists to prevent. A missing file is an empty list rather than a
 * failure — that is a user who has built no combos. A corrupt file leaves the store empty and the
 * error held, so a query says so instead of claiming there are none.
 */
export function loadCombosSync(): void {
  try {
    const raw = readFileSync(combosFilePath(), 'utf8')
    const combos = parseCombos(raw)
    loadError = null
    publish(combos)
  } catch (err) {
    if (isMissingFile(err)) {
      loadError = null
      publish([])
    } else {
      loadError = err instanceof ConveyorError ? err : ioError(err instanceof Error ? err.message : String(err))
      cache = []
    }
  }
  loaded = true
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

/** Read the file as it is now. Absent is an empty list; corrupt is a refusal. */
async function readCombosFile(): Promise<Combo[]> {
  let raw: string
  try {
    raw = await readFile(combosFilePath(), 'utf8')
  } catch (err) {
    if (isMissingFile(err)) return []
    throw ioError(err instanceof Error ? err.message : String(err))
  }
  return parseCombos(raw)
}

/**
 * Write the list atomically: a temp sibling, then a rename over the target.
 *
 * The discipline `memory.ts` uses and `saveTranscriptFile` established: the rename is what makes it
 * atomic, the temp carries the pid so two writers cannot collide on it, and a failed write removes
 * its temp rather than leaving a file that a later read would mistake for the real one.
 */
async function writeCombosFile(combos: Combo[]): Promise<void> {
  const target = combosFilePath()
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ combos }), 'utf8')
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw ioError(err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------- serialization

/** The tail of the mutation chain. Every command waits for it and extends it with its own work. */
let chain: Promise<unknown> = Promise.resolve()

/**
 * Run one mutation after every mutation before it has settled.
 *
 * Rejections are caught on the *chain* rather than swallowed for the caller: a failed command still
 * releases the next one, because a refusal is a state the file is in and the next command has to be
 * able to read that state. The caller receives its own task's answer, rejection included.
 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ---------------------------------------------------------------- reads

/** The field list, for the Settings screen and the picker. */
export function listCombos(): Combo[] {
  if (!loaded) {
    throw new ConveyorError('COMBO_IO_ERROR', 'Combos have not been loaded yet.')
  }
  if (loadError) throw loadError
  return cache.map((combo) => ({ ...combo, members: combo.members.map((member) => ({ ...member })) }))
}

/**
 * One combo by id, for the run that named it.
 *
 * Read from the cache, which the initial load and every successful write keep current. A combo that
 * was deleted after the renderer chose it is `COMBO_NOT_FOUND` — the refusal the picker's stale
 * guard mirrors, and the one the loop needs if a send slips through.
 */
export function comboForRun(comboId: string): Combo {
  const combo = cache.find((entry) => entry.id === comboId)
  if (!combo) {
    throw new ConveyorError('COMBO_NOT_FOUND', 'That combo is no longer available. Choose another target.')
  }
  return { ...combo, members: combo.members.map((member) => ({ ...member })) }
}

// ---------------------------------------------------------------- mutations

/** Read the file, apply one change to it, write it, and publish what was written. */
async function mutate(change: (current: Combo[]) => Combo[]): Promise<Combo[]> {
  const current = await readCombosFile()
  const next = change(current)
  await writeCombosFile(next)
  loadError = null
  loaded = true
  publish(next)
  return next
}

function notFound(id: string): ConveyorError {
  return new ConveyorError('COMBO_NOT_FOUND', `No combo named '${id}'.`)
}

function find(current: readonly Combo[], id: string): Combo {
  const combo = current.find((entry) => entry.id === id)
  if (!combo) throw notFound(id)
  return combo
}

/** A name with no character the slug rule keeps. */
function comboSlugless(name: string): boolean {
  return !/[a-z0-9]/i.test(name)
}

/**
 * Create a combo and its first member in one write.
 *
 * Creation cannot be a separate step from its first member: the file's own schema requires
 * `members.min(1)`, and a combo that existed for a moment with none would be a shape no reader
 * accepts. The renderer's create form therefore collects the name first and adds a member in the
 * same command — `create` means "a combo that can be resolved", not "an empty row".
 */
export function createComboWithMember(input: { name: string; providerId: string; modelId: string }): Promise<Combo> {
  return serialize(async () => {
    const trimmed = input.name.trim()
    if (!trimmed) throw new ConveyorError('COMBO_EMPTY', 'A combo needs a name.')
    if (comboSlugless(trimmed)) throw new ConveyorError('COMBO_EMPTY', 'A combo name needs letters or digits.')

    const member: ComboMember = { providerId: input.providerId, modelId: input.modelId }
    if (!comboMemberKnown(member, currentComboRegistry())) {
      throw new ConveyorError('COMBO_MEMBER_UNKNOWN', 'That provider and model are not known here.')
    }

    let created: Combo | null = null
    await mutate((current) => {
      const id = newComboId(
        trimmed,
        current.map((combo) => combo.id)
      )
      if (current.some((combo) => combo.id === id)) throw new ConveyorError('COMBO_ID_TAKEN', 'That combo id is taken.')
      created = { id, name: trimmed, members: [member], enabled: true }
      return [...current, created]
    })

    return created as unknown as Combo
  })
}

/** Retitle a combo. The id does not move. */
export function renameCombo(id: string, name: string): Promise<Combo> {
  return serialize(async () => {
    const trimmed = name.trim()
    if (!trimmed) throw new ConveyorError('COMBO_EMPTY', 'A combo needs a name.')
    let renamed: Combo | null = null
    await mutate((current) => {
      const combo = find(current, id)
      renamed = { ...combo, name: trimmed }
      return current.map((entry) => (entry.id === id ? (renamed as Combo) : entry))
    })
    return renamed as unknown as Combo
  })
}

/** Move one member of a combo up or down its priority list. */
export function reorderCombo(id: string, from: number, to: number): Promise<Combo> {
  return serialize(async () => {
    let moved: Combo | null = null
    await mutate((current) => {
      const combo = find(current, id)
      if (from < 0 || from >= combo.members.length || to < 0 || to >= combo.members.length) {
        throw new ConveyorError('COMBO_NOT_FOUND', 'That member position does not exist.')
      }
      moved = { ...combo, members: moveComboMember(combo.members, from, to) }
      return current.map((entry) => (entry.id === id ? (moved as Combo) : entry))
    })
    return moved as unknown as Combo
  })
}

/** Add a member. A pair already present is idempotent and writes the list back unchanged. */
export function addComboMember(id: string, member: ComboMember): Promise<Combo> {
  return serialize(async () => {
    let updated: Combo | null = null
    await mutate((current) => {
      const combo = find(current, id)
      if (combo.members.some((existing) => sameComboMember(existing, member))) {
        updated = combo
        return current
      }
      if (combo.members.length >= MAX_COMBO_MEMBERS) {
        throw new ConveyorError('COMBO_LIMIT', `A combo can hold at most ${MAX_COMBO_MEMBERS} members.`)
      }
      if (!comboMemberKnown(member, currentComboRegistry())) {
        throw new ConveyorError('COMBO_MEMBER_UNKNOWN', 'That provider and model are not known here.')
      }
      updated = { ...combo, members: appendComboMember(combo.members, member) }
      return current.map((entry) => (entry.id === id ? (updated as Combo) : entry))
    })
    return updated as unknown as Combo
  })
}

/** Remove a member. The last member cannot go: a combo with none cannot resolve and is not a combo. */
export function removeComboMemberById(id: string, member: ComboMember): Promise<Combo> {
  return serialize(async () => {
    let updated: Combo | null = null
    await mutate((current) => {
      const combo = find(current, id)
      if (!combo.members.some((existing) => sameComboMember(existing, member))) {
        updated = combo
        return current
      }
      if (combo.members.length <= 1) {
        throw new ConveyorError('COMBO_EMPTY', 'A combo needs at least one member. Delete the combo instead.')
      }
      updated = { ...combo, members: removeComboMember(combo.members, member) }
      return current.map((entry) => (entry.id === id ? (updated as Combo) : entry))
    })
    return updated as unknown as Combo
  })
}

/** Offer or hide a combo in the picker. */
export function setComboEnabled(id: string, enabled: boolean): Promise<Combo> {
  return serialize(async () => {
    let updated: Combo | null = null
    await mutate((current) => {
      const combo = find(current, id)
      updated = { ...combo, enabled }
      return current.map((entry) => (entry.id === id ? (updated as Combo) : entry))
    })
    return updated as unknown as Combo
  })
}

/** Delete a combo. */
export function deleteCombo(id: string): Promise<void> {
  return serialize(async () => {
    await mutate((current) => {
      find(current, id)
      return current.filter((entry) => entry.id !== id)
    })
  })
}

// ---------------------------------------------------------------- the module

export const combosModule = defineModule({
  /** Every combo, in creation order. */
  list: query(() => listCombos()),

  /** Create a combo with its first member, in one write. */
  create: command(
    z.object({ name: z.string().min(1), providerId: z.string().min(1), modelId: z.string().min(1) }),
    async ({ input }) => createComboWithMember(input)
  ),

  rename: command(z.object({ id: z.string().min(1), name: z.string().min(1) }), async ({ input }) =>
    renameCombo(input.id, input.name)
  ),

  reorder: command(
    z.object({
      id: z.string().min(1),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
    async ({ input }) => reorderCombo(input.id, input.from, input.to)
  ),

  addMember: command(
    z.object({ id: z.string().min(1), providerId: z.string().min(1), modelId: z.string().min(1) }),
    async ({ input }) => addComboMember(input.id, { providerId: input.providerId, modelId: input.modelId })
  ),

  removeMember: command(
    z.object({ id: z.string().min(1), providerId: z.string().min(1), modelId: z.string().min(1) }),
    async ({ input }) => removeComboMemberById(input.id, { providerId: input.providerId, modelId: input.modelId })
  ),

  setEnabled: command(z.object({ id: z.string().min(1), enabled: z.boolean() }), async ({ input }) =>
    setComboEnabled(input.id, input.enabled)
  ),

  delete: command(z.object({ id: z.string().min(1) }), async ({ input }) => deleteCombo(input.id)),

  /**
   * The providers and models a combo may name, flattened for the two Settings selects.
   *
   * One read rather than two, because the second select's list depends on the first's choice and both
   * come from the same registry. The renderer never ships a descriptor: this is labels and ids.
   */
  knownTargets: query(() =>
    currentComboRegistry().providers.map((entry) => ({
      providerId: entry.id,
      providerName: entry.name,
      models: [...new Set([...entry.enabledModels, ...entry.fetchedModels, ...entry.defaultModels])],
    }))
  ),
})

/**
 * Re-exported for the loop, which plans its walk from the same snapshot the guard reads.
 *
 * The member type travels too so the agent's own imports stay one line; nothing here is a second
 * definition of it.
 */
export type { ComboMember }
