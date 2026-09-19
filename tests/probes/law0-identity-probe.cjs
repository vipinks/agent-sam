// Law 0 probe: does a renamed build still resolve the same userData directory, and can it still
// decrypt keys that were written under the old identity?
//
// This is the check that must not be skipped. `settings/api-keys.json`, `sessions/` and
// `conveyor-stores/` all hang off `app.getPath('userData')`, which derives from the app's identity,
// so a branding change is a data-continuity change. The only honest way to settle it is to launch
// real Electron under each candidate identity and read back the real files.
//
// Run it against one identity by pointing Electron at a directory whose package.json declares that
// identity; the harness script does that for each variant and compares the results.
const { app, safeStorage } = require('electron')
const { readFileSync, existsSync, readdirSync } = require('fs')
const { join } = require('path')

// Optional override used to test the migration ladder: pin userData to a named directory under
// appData, exactly as main.ts would with `app.setPath('userData', ...)`. It must run before the app is
// ready and before anything touches a userData path, which is why it sits at module scope.
//
// This exists so the probe can answer the question variant C leaves open: when productName moves
// userData, does decryption break because of the *path*, or because of the app identity itself? If
// pinning the path restores decryption, then "keep resolving to the same directory" is a sufficient
// Law 0 remedy and no migration is warranted.
const PIN = process.env.LAW0_PIN_USERDATA
if (PIN) app.setPath('userData', join(app.getPath('appData'), PIN))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
}

// The identity Electron actually resolved for this run — the input to every path below.
function identity() {
  return {
    name: app.name,
    productName: (() => {
      try {
        return require(join(app.getAppPath(), 'package.json')).productName ?? null
      } catch {
        return null
      }
    })(),
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
  }
}

async function main() {
  const id = identity()
  // Printed as a single machine-readable line so the harness can diff variants without guessing.
  console.log(
    `IDENTITY ${JSON.stringify({ name: id.name, productName: id.productName, userData: id.userData, pinned: PIN || null })}`
  )

  // --- the baseline directory this app has always used
  const baseline = join(id.appData, 'era')
  record('the pre-existing userData directory exists', existsSync(baseline), baseline)

  // --- does THIS identity resolve to that same directory? (the whole question)
  record(
    'this identity resolves to the baseline userData',
    id.userData === baseline,
    id.userData === baseline ? 'same directory' : `resolved elsewhere: ${id.userData}`
  )

  // --- can this identity still decrypt a key written under the old one?
  //     Read through the baseline path, not this app's own userData, so a rename cannot hide the
  //     answer behind a missing file.
  const keyFile = join(baseline, 'settings', 'api-keys.json')
  if (!existsSync(keyFile)) {
    record('a pre-existing key file is available to test', false, `none at ${keyFile}`)
  } else {
    record('a pre-existing key file is available to test', true, keyFile)
    const stored = JSON.parse(readFileSync(keyFile, 'utf8'))
    const providers = Object.keys(stored)
    record('the key file holds provider entries', providers.length > 0, providers.join(', '))

    if (!safeStorage.isEncryptionAvailable()) {
      record('safeStorage is available for decryption', false, 'unavailable on this machine')
    } else {
      record('safeStorage is available for decryption', true, 'available')
      let decrypted = 0
      let failed = []
      for (const provider of providers) {
        try {
          const value = safeStorage.decryptString(Buffer.from(stored[provider], 'base64'))
          if (value && value.length > 0) decrypted += 1
        } catch (err) {
          failed.push(`${provider}: ${err && err.message ? err.message : String(err)}`)
        }
      }
      record(
        'keys written under the old identity still decrypt',
        failed.length === 0 && decrypted === providers.length,
        failed.length ? failed.join(' | ') : `${decrypted}/${providers.length} decrypted`
      )
    }
  }

  // --- can this identity still read a saved session? Sessions are plain JSON, so this checks the
  //     path derivation rather than the crypto, and it is the second half of "user data survives".
  const sessionsDir = join(baseline, 'sessions')
  if (!existsSync(sessionsDir)) {
    record('a pre-existing session file is available to test', false, `none at ${sessionsDir}`)
  } else {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
    const first = files[0]
    let readable = false
    let detail = 'no files'
    if (first) {
      try {
        const parsed = JSON.parse(readFileSync(join(sessionsDir, first), 'utf8'))
        readable = Boolean(parsed && typeof parsed === 'object' && 'turns' in parsed)
        detail = `${first}: ${Array.isArray(parsed.turns) ? parsed.turns.length : '?'} turns`
      } catch (err) {
        detail = `${first}: ${err && err.message ? err.message : String(err)}`
      }
    }
    record('a saved session is readable from the baseline directory', readable, detail)
  }
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    record('probe crashed', false, String(err && err.stack ? err.stack : err))
  }
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'pass' : 'FAIL'} :: ${r.name} :: ${r.detail}`)
  console.log(`law0 probe: ${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length ? 1 : 0)
})
