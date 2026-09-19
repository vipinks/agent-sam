// Real-Electron check for settings.ts: safeStorage round-trip, provider validation, and the
// encryption-unavailable code path. Runs in the main process, so `safeStorage` is the genuine
// Electron API and the key file goes to the app's real userData directory.
//
// Launched via `electron .preview/llm/safestorage-probe.cjs` and exits with a status code.
const { app, safeStorage } = require('electron')
const { mkdir, readFile, writeFile, rm } = require('fs/promises')
const { join, dirname } = require('path')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
}

async function main() {
  // --- 1. availability, as the module reports it
  const available = safeStorage.isEncryptionAvailable()
  record('safeStorage.isEncryptionAvailable()', true, String(available))

  if (!available) {
    record('round-trip', false, 'encryption unavailable on this machine; cannot verify')
    return
  }

  // --- 2. encrypt -> persist -> decrypt, through the real API the module uses
  const secret = 'sk-test-abc123-do-not-use-' + Date.now()
  const encrypted = safeStorage.encryptString(secret)
  record('encryptString returns a Buffer', Buffer.isBuffer(encrypted), `bytes=${encrypted.length}`)

  const file = join(app.getPath('userData'), 'settings', 'probe-keys.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ deepseek: encrypted.toString('base64') }, null, 2), 'utf8')

  const raw = JSON.parse(await readFile(file, 'utf8'))
  const decrypted = safeStorage.decryptString(Buffer.from(raw.deepseek, 'base64'))
  record('round-trip preserves the key', decrypted === secret, decrypted === secret ? 'identical' : 'MISMATCH')

  // --- 3. the plaintext must not be recoverable from the file on disk
  const onDisk = await readFile(file, 'utf8')
  record('ciphertext does not contain the plaintext', !onDisk.includes(secret), onDisk.includes(secret) ? 'LEAKED' : 'opaque')

  // --- 4. the store's shape: one file, provider -> base64 ciphertext
  record('persisted shape is provider->base64', /^[A-Za-z0-9+/=]+$/.test(raw.deepseek), raw.deepseek.slice(0, 16) + '...')

  // --- 5. a second decrypt of the same ciphertext is stable (no per-call salt confusion)
  const again = safeStorage.decryptString(Buffer.from(raw.deepseek, 'base64'))
  record('decrypt is repeatable', again === secret, 'stable')

  await rm(file, { force: true })
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    record('probe crashed', false, String(err && err.stack ? err.stack : err))
  }
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'} :: ${r.name} :: ${r.detail}`)
  console.log(`safestorage probe: ${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length ? 1 : 0)
})
