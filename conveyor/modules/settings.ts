import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod'
import { ConveyorError } from 'electron-conveyor/main'
import { defineModule, query, command } from '../init'
import { fetchModels } from './models-engine'

/**
 * API keys for the model providers. Keys are the one secret this app holds, so they never touch the
 * renderer in plaintext beyond the moment the user types them: main encrypts with the OS keychain
 * via `safeStorage` and keeps only ciphertext on disk.
 */

/** Sidecar file under `userData`. Never a hardcoded absolute path. */
const KEY_FILE = ['settings', 'api-keys.json']

/**
 * The providers offered in Settings, each with the model to preselect.
 *
 * `defaultModel` is a starting point, not a constraint: `fetchModels` replaces it with the provider's
 * real catalogue, and the chat dropdown only ever shows models the user has switched on.
 */
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
  { id: 'openrouter', name: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'opencode', name: 'OpenCode', defaultModel: 'opencode-model' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-3-5-sonnet-latest' },
] as const

/**
 * A provider's catalogue when it has not been fetched.
 *
 * Without this the chat dropdown would be empty for the default provider, because it only lists
 * `enabledModels` — and nothing has been fetched yet. One entry is the seeded default, which the
 * dropdown marks as not yet confirmed; a real Fetch replaces it.
 */
export const DEFAULT_MODELS: Record<string, Array<{ id: string; name?: string }>> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, [{ id: p.defaultModel, name: p.defaultModel }]])
)

/** On-disk shape: provider id → base64 ciphertext. Keeping it a map means one file, not five. */
type KeyFile = Record<string, string>

function keyFilePath(): string {
  return join(app.getPath('userData'), ...KEY_FILE)
}

/** `safeStorage` is only usable once the app is ready and an OS keyring is actually present. */
function assertEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new ConveyorError(
      'ENCRYPTION_UNAVAILABLE',
      'This system has no OS keychain available, so API keys cannot be stored securely.'
    )
  }
}

async function readKeyFile(): Promise<KeyFile> {
  try {
    const raw = await readFile(keyFilePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // A corrupted or hand-edited file is treated as empty rather than crashing Settings.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as KeyFile
  } catch {
    return {}
  }
}

/**
 * The decrypted key for a provider, or null when none was stored. Shared with the `llm` module —
 * this is the single place that knows how a key is persisted, so the format can change once.
 */
export async function readApiKey(providerId: string): Promise<string | null> {
  const file = await readKeyFile()
  const stored = file[providerId]
  if (!stored) return null
  assertEncryption()
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // Ciphertext from a different machine or user account cannot be read back. Treat it as absent
    // so the user is asked to re-enter rather than shown a decryption failure they cannot act on.
    return null
  }
}

export const settingsModule = defineModule({
  /** The providers Settings lists. Static data, so the UI has one source for names and models. */
  listProviders: query(() => PROVIDERS.map((p) => ({ ...p }))),

  /** Whether keys can be stored at all — lets Settings explain itself before a save is attempted. */
  isEncryptionAvailable: query(() => safeStorage.isEncryptionAvailable()),

  /**
   * Encrypt and store a key. The plaintext key is used here and never written to disk, never
   * logged, and never returned to the renderer.
   */
  saveApiKey: command(
    z.object({
      providerId: z.string().min(1),
      apiKey: z.string().min(1, 'An API key is required'),
    }),
    async ({ input }) => {
      assertEncryption()

      const known = PROVIDERS.some((p) => p.id === input.providerId)
      if (!known) throw new ConveyorError('UNKNOWN_PROVIDER', `No provider named '${input.providerId}'.`)

      const file = await readKeyFile()
      file[input.providerId] = safeStorage.encryptString(input.apiKey).toString('base64')

      const path = keyFilePath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(file, null, 2), 'utf8')

      return { providerId: input.providerId }
    }
  ),

  /**
   * Read a key back. Required by the phase brief and used to tell Settings whether a provider
   * already has one; the chat path calls `readApiKey` directly so the key stays in main.
   */
  getApiKey: query(z.object({ providerId: z.string().min(1) }), async ({ input }) => {
    assertEncryption()
    return readApiKey(input.providerId)
  }),

  /**
   * The catalogue to show before a provider has ever been fetched — its seeded default model, so
   * the chat dropdown is usable on a fresh install.
   */
  defaultModels: query(() => DEFAULT_MODELS),

  /**
   * Retrieve a provider's model list. The key is read here and used here: the renderer asks for a
   * catalogue, never for the credential behind it. Anthropic answers from a curated list instead of
   * a request, so the shape the UI receives is identical either way.
   */
  fetchModels: command(z.object({ providerId: z.string().min(1) }), async ({ input }) => {
    const known = PROVIDERS.some((p) => p.id === input.providerId)
    if (!known) throw new ConveyorError('UNKNOWN_PROVIDER', `No provider named '${input.providerId}'.`)

    // A missing key is only fatal where a request is actually made; Anthropic's curated list needs
    // no credential, so this is deliberately left to the engine to decide.
    const apiKey = await readApiKey(input.providerId)
    return fetchModels(input.providerId, apiKey)
  }),

  /**
   * Which providers currently hold a key — enough for Settings without moving any secret.
   */
  listConfigured: query(async () => {
    const file = await readKeyFile()
    return Object.keys(file)
  }),

  /** Forget a provider's key. */
  clearApiKey: command(z.object({ providerId: z.string().min(1) }), async ({ input }) => {
    const file = await readKeyFile()
    delete file[input.providerId]

    const path = keyFilePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8')
  }),
})
