import { z } from 'zod'

/**
 * Model combos: a named priority list of provider/model pairs, and the rules that decide which one
 * serves a request.
 *
 * Pure, and its only import is `zod`. Two processes need this vocabulary: main walks the list when a
 * turn is sent, and the renderer offers the same names, the same counts and the same refusals in
 * Settings and in the model picker. A module import here would drag main-only code into the renderer
 * bundle, which is why the shapes below describe windows and descriptors structurally instead of
 * naming the modules that own them.
 *
 * The member is deliberately two strings and nothing else. A combo cannot hold another combo because
 * there is nowhere to put one: nesting is unrepresentable rather than refused, which is what keeps a
 * resolver from having to recurse and a settings row from having to draw a tree.
 */

/** How many members one combo may hold. A cap, not a preference: the walk is tried in order. */
export const MAX_COMBO_MEMBERS = 8

/** How long a combo's name may be, after trimming. */
export const MAX_COMBO_NAME_CHARS = 60

/** How long a combo's id may be. The slug rule below stays inside this bound. */
export const MAX_COMBO_ID_CHARS = 64

/**
 * One candidate, as it is stored and as it crosses the bridge.
 *
 * Exactly two fields. The `.strict()` is the structural half of the nesting rule: an object carrying
 * a `members` key inside a member is not a member this build reads, so a hand-edited file cannot
 * smuggle a nested combo into the walk.
 */
export const comboMemberSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict()

export type ComboMember = z.infer<typeof comboMemberSchema>

/**
 * A combo as it is stored: an id derived from the name, the name itself, its members in priority
 * order, and whether the picker offers it.
 *
 * The id is a slug rather than a random string because a combo is named by a person and the id is
 * read in a payload; it is derived once, at creation, and a rename leaves it alone, so a saved
 * session that recorded `combo::fast` keeps naming the same combo after the user retitles it.
 */
export const comboSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_COMBO_ID_CHARS)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'A combo id is a slug: lowercase letters, digits and dashes.'),
  name: z.string().trim().min(1).max(MAX_COMBO_NAME_CHARS),
  members: z.array(comboMemberSchema).min(1).max(MAX_COMBO_MEMBERS),
  enabled: z.boolean(),
})

export type Combo = z.infer<typeof comboSchema>

/**
 * The slug a name becomes.
 *
 * Bounded by construction: the input is lowercased, every run of characters outside `[a-z0-9]` is
 * collapsed to one dash, the ends are trimmed, and the result is cut to the id bound. An empty slug
 * is the caller's to notice — `newComboId` supplies the fallback — because "a name that is all
 * punctuation" and "a name of spaces" are the same fact here.
 */
export function comboSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_COMBO_ID_CHARS)
    .replace(/-+$/g, '')
}

/**
 * An id for a combo, free of collisions with the ids already in use.
 *
 * The same derivation `newProviderId` uses, for the same reason: a form can compute the id it is
 * about to create before the store has answered, and a second combo with a name that slugs to an
 * existing id gets a numeric suffix rather than a second row under the same id.
 */
export function newComboId(name: string, existing: readonly string[]): string {
  const base = comboSlug(name) || 'combo'
  if (!existing.includes(base)) return base

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existing.includes(candidate)) return candidate
  }
}

/** Whether two members name the same candidate. */
export function sameComboMember(left: ComboMember, right: ComboMember): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId
}

/** The list with one member on the end, or the same list when the pair is already there. */
export function appendComboMember(members: readonly ComboMember[], member: ComboMember): ComboMember[] {
  if (members.some((existing) => sameComboMember(existing, member))) return [...members]
  return [...members, { providerId: member.providerId, modelId: member.modelId }]
}

/** The list without one member. Absent is not an error: the list asked for is the list it has. */
export function removeComboMember(members: readonly ComboMember[], member: ComboMember): ComboMember[] {
  return members.filter((existing) => !sameComboMember(existing, member))
}

/** The list with one entry moved, clamped to its own bounds. */
export function moveComboMember(members: readonly ComboMember[], from: number, to: number): ComboMember[] {
  if (members.length === 0) return []
  const at = Math.min(Math.max(Math.trunc(from), 0), members.length - 1)
  const target = Math.min(Math.max(Math.trunc(to), 0), members.length - 1)
  if (at === target) return [...members]

  const next = [...members]
  const [moved] = next.splice(at, 1)
  next.splice(target, 0, moved)
  return next
}

// ---------------------------------------------------------------- failure disposition

/**
 * What the walk does with a failure: move to the next member, or stop and tell the user.
 *
 * `advance` is the set a second member could plausibly answer: the credential was refused, the key
 * is rate limited or out of credit, the network is down, the provider is having a server error, or
 * this machine holds no key for that provider at all. None of those is evidence about the *prompt*,
 * so a different provider may answer it.
 *
 * `surface` is everything a different provider would hit too, or that says the request itself is
 * wrong: a reply that stopped arriving (the model already spoke, and advancing would splice two
 * answers together), an unknown or invalid provider, an unavailable keychain, an image or skill the
 * turn cannot send, and a 4xx that is not a rate limit — a malformed request or a content refusal,
 * which is a fact about this prompt rather than about who was asked. The two are indistinguishable
 * at the status level, which is why both arrive here as `PROVIDER_REQUEST_INVALID` and both surface.
 *
 * `PROVIDER_ERROR` is in the advance set because the classification fix moved every non-5xx 4xx off
 * it: after that change the code means a 5xx for an HTTP refusal, and a server error is exactly the
 * failure a second member exists for. A mid-stream provider error shares the code and is rare; the
 * surface set's membership is about the code, not about every producer of it.
 *
 * Timeout is deliberately absent from the advance set this slice (ruling 6a). There is no chat
 * request timer — a provider that hangs simply hangs — and adding one here would cut long
 * generations, which is a larger decision than a failover walk. It is a parked gap, named rather
 * than half-built.
 *
 * Unknown codes surface. A code this build has not classified is not evidence that advancing is
 * safe, and the conservative answer is the one the user can see.
 */
const ADVANCE_CODES: readonly string[] = [
  'AUTH_FAILED',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
  'NO_API_KEY',
]

export type ComboFailureDisposition = 'advance' | 'surface'

export function comboFailureDisposition(code: string): ComboFailureDisposition {
  return ADVANCE_CODES.includes(code) ? 'advance' : 'surface'
}

// ---------------------------------------------------------------- the registry snapshot

/**
 * One provider as the resolvers see it: what it offers, what is switched on, and whether this
 * machine holds a credential for it.
 *
 * Declared structurally rather than imported from the provider-config store, because this file may
 * not import outside `zod`. `descriptor` is the custom provider's own record, opaque here and
 * validated where a request is built; built-ins carry none, because main's table answers by id.
 */
export interface ComboWindowDeclaration {
  contextWindow?: number
}

export interface ComboRegistryEntry {
  id: string
  name: string
  kind: 'built-in' | 'custom'
  /** The models the user switched on, in the order they were enabled. Empty means "not known yet". */
  enabledModels: readonly string[]
  /** The last fetched catalogue, and a custom provider's declared models. */
  fetchedModels: readonly string[]
  /** The models this build ships for the provider. */
  defaultModels: readonly string[]
  supportsImages: boolean
  /** The declared windows, keyed by model. */
  modelWindows: Record<string, ComboWindowDeclaration>
  /** Each known model's window, already resolved by the snapshot's builder. */
  windows: Record<string, number>
  /** Whether a key is stored for this provider. A custom provider may legitimately have none. */
  hasKey: boolean
  /** The custom provider's descriptor, or absent for a built-in. */
  descriptor?: unknown
}

export interface ComboRegistrySnapshot {
  providers: readonly ComboRegistryEntry[]
}

/** One provider's entry, or undefined. */
export function comboRegistryEntry(
  snapshot: ComboRegistrySnapshot,
  providerId: string
): ComboRegistryEntry | undefined {
  return snapshot.providers.find((entry) => entry.id === providerId)
}

/**
 * Every model id a provider is known to offer: switched on, fetched, shipped, or declared by a
 * custom descriptor (which the snapshot files under `fetchedModels`).
 */
export function comboKnownModels(entry: ComboRegistryEntry): string[] {
  return [...new Set([...entry.enabledModels, ...entry.fetchedModels, ...entry.defaultModels])]
}

/**
 * Whether the registry knows this member at all.
 *
 * The member guard's whole rule: a combo may be built before its models are switched on, so this
 * asks about the catalogue and not about the enable list. Everything the registry knows — enabled,
 * fetched, shipped, declared — is accepted; a provider or model nobody has heard of is refused under
 * `COMBO_MEMBER_UNKNOWN`. Members are never pruned when a provider goes away; they stay and are
 * reported ineligible at resolve time, which is why this is asked when a member is added and not
 * when the file is read.
 */
export function comboMemberKnown(member: ComboMember, snapshot: ComboRegistrySnapshot): boolean {
  const entry = comboRegistryEntry(snapshot, member.providerId)
  if (!entry) return false
  return comboKnownModels(entry).includes(member.modelId)
}

// ---------------------------------------------------------------- eligibility

/** Why a member cannot serve this request. Codes, so the card and the walk branch on them. */
export type ComboSkipReason = 'no-provider' | 'model-not-enabled' | 'no-key' | 'window-too-small' | 'no-vision'

/** What the request would cost, and what it carries besides text. */
export interface ComboRequestFacts {
  estimatedTokens: number
  images: number
}

/** One member and the verdict on it. */
export interface ComboCandidate {
  member: ComboMember
  eligible: boolean
  reason?: ComboSkipReason
}

/**
 * The five filters, in the order they are asked.
 *
 * Each answers a code and never a sentence, because the card's wording is the renderer's and the walk
 * only needs to know whether to skip. The order is the cheapest fact first, and it is also the order
 * a reader would ask them: does the provider exist, is the model switched on, would a keyless request
 * be refused, does it fit the window, can it see what is attached.
 *
 * `model-not-enabled` is the one rule with a deliberate exception: an absent or empty enabled list
 * means "nothing recorded yet", not "everything is off" — the same reading `reconcileTarget` uses —
 * so it never disqualifies. A non-empty list that omits the model does.
 *
 * `no-key` asks what `resolveRun` would do: a built-in provider with no stored key is refused before
 * a request, so the walk skips it; a custom provider is runnable with no key because a local server
 * usually wants none, so it stays eligible.
 *
 * `window-too-small` only speaks when a window is known. An unknown window is not a zero: a model
 * nothing knows is not disqualified by a number nobody supplied.
 *
 * `no-vision` is about the request, not the composer: the history's image references are what make a
 * provider that cannot see them the wrong candidate, even if the user attached the image a turn ago.
 */
export function comboMemberEligibility(
  member: ComboMember,
  snapshot: ComboRegistrySnapshot,
  request: ComboRequestFacts
): ComboSkipReason | null {
  const entry = comboRegistryEntry(snapshot, member.providerId)
  if (!entry) return 'no-provider'

  if (entry.enabledModels.length > 0 && !entry.enabledModels.includes(member.modelId)) return 'model-not-enabled'
  if (entry.kind === 'built-in' && !entry.hasKey) return 'no-key'

  const window = entry.windows[member.modelId]
  if (typeof window === 'number' && window > 0 && request.estimatedTokens > window) return 'window-too-small'

  if (request.images > 0 && !entry.supportsImages) return 'no-vision'
  return null
}

/**
 * The walk this request would take, planned once from the registry and the request's own facts.
 *
 * Pure and ordered: the members arrive in priority order and come back in it, each with its verdict.
 * The loop does not re-decide eligibility; it walks this list, skipping what is marked and attempting
 * what is not, and `comboFailureDisposition` decides what a failure during an attempt means.
 */
export function planComboWalk(
  combo: Combo,
  snapshot: ComboRegistrySnapshot,
  request: ComboRequestFacts
): ComboCandidate[] {
  return combo.members.map((member) => {
    const reason = comboMemberEligibility(member, snapshot, request)
    return reason === null ? { member, eligible: true } : { member, eligible: false, reason }
  })
}

// ---------------------------------------------------------------- the report

/**
 * One member the walk did not get an answer from, and why.
 *
 * `skipped` is a member the filters refused before a request; `failed` is one a request was made to
 * and whose failure the disposition said to advance past. The member travels with the record because
 * the card lists each of them, and a code without a name would be a list of reasons with no subjects.
 */
export interface ComboAttemptRecord {
  kind: 'skipped' | 'failed'
  providerId: string
  modelId: string
  reason?: ComboSkipReason
  code?: string
}

/**
 * What one turn's combo walk did, as the transcript records it.
 *
 * `requests` is the member that served each round-trip, in the order they ran — normally one, one per
 * round-trip of a turn that also called tools. `attempts` is every member moved on from, skipped or
 * failed. The pair is what lets a reopened conversation say both who answered and who did not.
 */
export interface ComboReport {
  id: string
  name: string
  requests: ComboMember[]
  attempts: ComboAttemptRecord[]
}
