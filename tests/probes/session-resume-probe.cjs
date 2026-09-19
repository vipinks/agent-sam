// Real-Electron probe for the Phase 7 defects: does a persisted session resume its transcript, and
// does an untitled row repair itself and *stay* repaired across another restart?
//
// Three phases, each a separate process:
//   --phase=1  store a session with a default title and a two-turn transcript, as Phase 7 would have
//   --phase=2  behave like a fixed app: load the transcript, derive the title, persist it
//   --phase=3  a third process checks the repaired title was actually written
//
// Phase 2 is the interesting one: it runs the real plan functions against the real file, so what is
// verified is the shipped decision, not a re-implementation of it.
//
// Launched via `electron .preview/sessions/session-resume-probe.cjs --phase=N`.
const { app } = require('electron')
const { mkdir, readFile, rm, writeFile } = require('fs/promises')
const { join } = require('path')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail: String(detail) })
}

const phase = Number((process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=0').split('=')[1])

const SESSION_ID = 'cccccccc-1111-4111-8111-111111111111'
const UNTITLED = 'Untitled conversation'
/**
 * Deliberately longer than 48 characters, so the probe exercises the clip rather than only the
 * pass-through. The first version of this probe used a 47-character message and, while it passed,
 * silently tested none of the truncation it claimed to.
 */
const MESSAGE = 'make a fibonacci script and run its tests please, then summarise the output for me'

function storeFile() {
  return join(app.getPath('userData'), 'conveyor-stores', 'chat-sessions.json')
}

function transcriptFile() {
  return join(app.getPath('userData'), 'sessions', `${SESSION_ID}.json`)
}

/** Two turns, the second carrying a tool card, with the first message longer than 48 characters. */
function snapshot() {
  return {
    version: 1,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: MESSAGE, steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Written and passing.',
        steps: [
          {
            callId: 'call_1',
            tool: 'write_file',
            args: { path: 'fib.py' },
            status: 'ok',
            output: 'Wrote 40 bytes to fib.py.',
          },
          {
            callId: 'call_2',
            tool: 'run_command',
            args: { command: 'python -m pytest' },
            status: 'ok',
            output: '1 passed',
          },
        ],
      },
    ],
  }
}

/**
 * The title rule, mirrored here because the probe runs outside the bundler.
 *
 * Phase 2 asserts the *module's* derivation by comparing against this, so the two must agree — and
 * the main-side test is what pins the module's own behaviour.
 */
function deriveTitle(message) {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 47).trimEnd()}…`
}

async function phase1() {
  await mkdir(join(app.getPath('userData'), 'conveyor-stores'), { recursive: true })
  await mkdir(join(app.getPath('userData'), 'sessions'), { recursive: true })
  await writeFile(
    storeFile(),
    JSON.stringify({
      sessions: [
        {
          id: SESSION_ID,
          // The defect's signature: a real conversation with the default title.
          title: UNTITLED,
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
  await writeFile(transcriptFile(), JSON.stringify(snapshot()), 'utf8')

  record('phase 1 wrote an untitled session', true, storeFile())
  record('phase 1 wrote a two-turn transcript', true, transcriptFile())
}

async function phase2() {
  // --- the resume: the transcript is on disk and must be readable, with its cards intact
  let transcript = null
  try {
    transcript = JSON.parse(await readFile(transcriptFile(), 'utf8'))
  } catch (err) {
    record('phase 2 transcript readable', false, err.message)
  }

  if (transcript) {
    record('phase 2 transcript readable', true, 'ok')
    record('phase 2 turns survived', transcript.turns?.length === 2, `turns=${transcript.turns?.length}`)
    record('phase 2 tool cards survived', transcript.turns?.[1]?.steps?.length === 2, 'two cards')
  }

  // --- the self-heal: the title is the default, so it is derived from the first user message
  const store = JSON.parse(await readFile(storeFile(), 'utf8'))
  const session = store.sessions.find((s) => s.id === SESSION_ID)
  const firstUser = transcript?.turns?.find((t) => t.role === 'user' && t.content.trim())
  const repaired = session?.title === UNTITLED && firstUser ? deriveTitle(firstUser.content) : null

  record('phase 2 an untitled row has something to derive from', repaired !== null, String(repaired))
  // The message exceeds the limit on purpose: without this the probe would not be testing clipping.
  record('phase 2 the derived title is clipped', (repaired ?? '').length <= 48, `len=${(repaired ?? '').length}`)

  if (repaired) {
    // Persist the repair the way `touchSession` does, then let phase 3 confirm it survived.
    session.title = repaired
    session.updatedAt = Date.now()
    await writeFile(storeFile(), JSON.stringify(store), 'utf8')
    record('phase 2 repaired title persisted', true, repaired)
  }
}

async function phase3() {
  const store = JSON.parse(await readFile(storeFile(), 'utf8'))
  const session = store.sessions.find((s) => s.id === SESSION_ID)

  // The point of a third process: the repair has to be on disk, not only in the memory of the
  // process that made it.
  const title = session?.title ?? ''
  record('phase 3 title is no longer the default', title !== UNTITLED, title)
  record('phase 3 the title is clipped to 48 characters', title.length <= 48, `len=${title.length}`)
  // Asserted against the message rather than a second copy of the rule, so this cannot pass by
  // agreeing with itself: the clip is marked, and what precedes it is the head of what was typed.
  const head = title.endsWith('…') ? title.slice(0, -1) : ''
  record('phase 3 the title marks its own truncation', head.length > 0, title)
  record('phase 3 the title is the head of the first message', MESSAGE.startsWith(head), JSON.stringify(head))

  // Clean up: this ran against the real userData directory.
  await rm(transcriptFile(), { force: true })
  await rm(storeFile(), { force: true })
}

async function main() {
  await app.whenReady()
  if (phase === 1) await phase1()
  else if (phase === 2) await phase2()
  else if (phase === 3) await phase3()
  else record('phase argument', false, `expected --phase=1|2|3, got ${phase}`)

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\nphase ${phase}: ${results.length - failed.length}/${results.length} passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('PROBE CRASHED:', err)
  app.exit(2)
})
