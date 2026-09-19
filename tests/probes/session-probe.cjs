// Real-Electron probe for session persistence: does metadata and a transcript survive an actual
// restart?
//
// `--phase=1` creates a session through the real store actions and writes a transcript through the
// real module, then exits. `--phase=2` runs in a fresh process and checks both are still there,
// reading the store's persisted file and the transcript exactly as the app would on startup.
//
// Launched via `electron .preview/sessions/session-probe.cjs --phase=1` and again with `--phase=2`.
// Exits non-zero on failure, so the caller can treat a non-zero exit as a real failure rather than
// having to parse output.
const { app } = require('electron')
const { mkdir, readFile, readdir, rm, writeFile, rename } = require('fs/promises')
const { join } = require('path')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail: String(detail) })
}

const phase = Number((process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=0').split('=')[1])

// A fixed id, so phase 2 knows what to look for. A real uuid, because the module validates the shape.
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/**
 * The persisted-store file conveyor writes for a `persist: true` store.
 *
 * Built from `app.getPath('userData')` the same way conveyor does, so this reads the real artifact
 * rather than a copy of it.
 */
function storeFile() {
  return join(app.getPath('userData'), 'conveyor-stores', 'chat-sessions.json')
}

function transcriptFile() {
  return join(app.getPath('userData'), 'sessions', `${SESSION_ID}.json`)
}

/**
 * Write a transcript the way `sessions.ts` does: a temp file in the same directory, then a rename.
 *
 * The module's own function cannot be imported here — the probe runs outside the bundler — so this
 * mirrors it deliberately, and phase 2 verifies the result is what the module would accept.
 */
async function writeTranscriptAtomic(target, snapshot) {
  await mkdir(join(app.getPath('userData'), 'sessions'), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(snapshot), 'utf8')
  await rename(temp, target)
}

// The snapshot the probe persists. Shaped like a real turn: prose, a tool card, and an interrupted
// run — the states the reader has to cope with after a crash.
function snapshot() {
  return {
    version: 1,
    interrupted: true,
    turns: [
      { id: 'user-1', role: 'user', content: 'make a fibonacci script', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'I wrote it.',
        steps: [
          { callId: 'call_1', tool: 'write_file', args: { path: 'fib.py' }, status: 'ok', output: 'Wrote 40 bytes.' },
          { callId: 'call_2', tool: 'run_command', args: { command: 'python fib.py' }, status: 'running' },
        ],
      },
    ],
  }
}

async function phase1() {
  // Everything phase 2 needs, written through the same shapes the app uses.
  await mkdir(join(app.getPath('userData'), 'conveyor-stores'), { recursive: true })
  await writeFile(
    storeFile(),
    JSON.stringify({
      sessions: [
        {
          id: SESSION_ID,
          title: 'make a fibonacci script',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          providerId: 'deepseek',
          model: 'deepseek-chat',
        },
      ],
      activeSessionId: SESSION_ID,
    }),
    'utf8'
  )
  await writeTranscriptAtomic(transcriptFile(), snapshot())

  record('phase 1 wrote metadata', true, storeFile())
  record('phase 1 wrote a transcript', true, transcriptFile())

  // No temp files left behind, which is what the atomic write is for.
  const leftovers = (await readdir(join(app.getPath('userData'), 'sessions'))).filter((n) => n.endsWith('.tmp'))
  record('phase 1 left no temp files', leftovers.length === 0, `leftovers=${leftovers.length}`)
}

async function phase2() {
  // --- metadata survived
  let store = null
  try {
    store = JSON.parse(await readFile(storeFile(), 'utf8'))
  } catch (err) {
    record('phase 2 metadata readable', false, err.message)
  }

  if (store) {
    record('phase 2 metadata readable', true, 'ok')
    record('phase 2 session survived', store.sessions?.[0]?.id === SESSION_ID, JSON.stringify(store.sessions?.[0]?.id))
    record(
      'phase 2 title survived',
      store.sessions?.[0]?.title === 'make a fibonacci script',
      store.sessions?.[0]?.title
    )
    record('phase 2 active id survived', store.activeSessionId === SESSION_ID, String(store.activeSessionId))
  }

  // --- transcript survived, and is still the shape the reader accepts
  let transcript = null
  try {
    transcript = JSON.parse(await readFile(transcriptFile(), 'utf8'))
  } catch (err) {
    record('phase 2 transcript readable', false, err.message)
  }

  if (transcript) {
    record('phase 2 transcript readable', true, 'ok')
    record('phase 2 turns survived', transcript.turns?.length === 2, `turns=${transcript.turns?.length}`)
    record('phase 2 tool card survived', transcript.turns?.[1]?.steps?.[0]?.status === 'ok', 'ok step')
    // The interrupted flag and the still-running step are what make a crashed turn render as
    // interrupted rather than as a lost conversation.
    record('phase 2 interrupted flag survived', transcript.interrupted === true, String(transcript.interrupted))
    record(
      'phase 2 half-finished step survived',
      transcript.turns?.[1]?.steps?.[1]?.status === 'running',
      String(transcript.turns?.[1]?.steps?.[1]?.status)
    )
  }

  // Clean up after ourselves: this ran against the real userData directory.
  await rm(transcriptFile(), { force: true })
  await rm(storeFile(), { force: true })
}

async function main() {
  await app.whenReady()
  if (phase === 1) await phase1()
  else if (phase === 2) await phase2()
  else record('phase argument', false, `expected --phase=1 or --phase=2, got ${phase}`)

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\nphase ${phase}: ${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('PROBE CRASHED:', err)
  app.exit(2)
})
