import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_VERSION, transcriptSnapshotSchema } from '@/conveyor/protocol/transcript'
import { rehydrateTranscript, serializeTranscript } from '@/app/components/workbench/session-transcript'
import { isDirty } from '@/app/components/workbench/session-rules'

/**
 * The consent setting as a property of the record, rather than as wiring.
 *
 * Two promises are pinned here that no DOM test can state. The first is that the field is additive: a
 * record written before it existed still reads, unchanged, at the version its reader already handles —
 * which is the whole difference between a field a reader can ignore and a change it would get wrong. The
 * second is that a session with the setting off stores nothing at all, because "off" and "never set" mean
 * the same to every reader of the record, and a stored `false` would claim a decision nobody made.
 */

/** A record from before the setting existed: the fields every transcript has always had. */
const BEFORE = { version: TRANSCRIPT_VERSION, interrupted: false, turns: [] }

describe('a record written before the setting existed', () => {
  it('reads exactly as written, with no key invented for it', () => {
    const parsed = transcriptSnapshotSchema.parse(BEFORE)

    expect(parsed).toEqual(BEFORE)
    expect('autoApprove' in parsed).toBe(false)
  })

  it('reads a record that carries the setting at the same version', () => {
    // The additive claim, stated as a fact about the reader: a file with the setting needs no version
    // change to be understood, and a file without it is not upgraded on the way in.
    const parsed = transcriptSnapshotSchema.parse({ ...BEFORE, autoApprove: true })

    expect(parsed.version).toBe(TRANSCRIPT_VERSION)
    expect(parsed.autoApprove).toBe(true)
  })

  it('comes back as off when it is loaded', () => {
    expect(rehydrateTranscript(transcriptSnapshotSchema.parse(BEFORE)).autoApprove).toBe(false)
  })

  it('refuses a record whose setting is not a boolean', () => {
    expect(transcriptSnapshotSchema.safeParse({ ...BEFORE, autoApprove: 'yes' }).success).toBe(false)
  })
})

describe('what a session stores for its own setting', () => {
  it('writes no key when the setting is off, or was never set', () => {
    expect('autoApprove' in serializeTranscript({ turns: [], interrupted: false })).toBe(false)
    expect('autoApprove' in serializeTranscript({ turns: [], interrupted: false, autoApprove: false })).toBe(false)
  })

  it('writes the key when the setting is on', () => {
    const snapshot = serializeTranscript({ turns: [], interrupted: false, autoApprove: true })

    expect(snapshot.autoApprove).toBe(true)
    expect(snapshot.version).toBe(TRANSCRIPT_VERSION)
  })

  it('reads a written setting back through the record it was stored in', () => {
    const written = serializeTranscript({ turns: [], interrupted: false, autoApprove: true })
    const stored = transcriptSnapshotSchema.parse(JSON.parse(JSON.stringify(written)) as unknown)

    expect(rehydrateTranscript(stored).autoApprove).toBe(true)
  })
})

describe('whether a consent change is worth a write', () => {
  it('counts an empty session with the setting on as worth writing', () => {
    // The one empty conversation that is worth a file: toggling on is a choice, and a session toggled and
    // left before its first message should still open with it on.
    expect(isDirty({ turns: [], interrupted: false, autoApprove: true }, null)).toBe(true)
  })

  it('still refuses an empty session with nothing set', () => {
    expect(isDirty({ turns: [], interrupted: false }, null)).toBe(false)
  })

  it('counts turning the setting off against a record that had it on', () => {
    const stored = serializeTranscript({ turns: [], interrupted: false, autoApprove: true })

    expect(isDirty({ turns: [], interrupted: false, autoApprove: false }, stored)).toBe(true)
  })

  it('sees no change when the setting is set to what is already stored', () => {
    const stored = serializeTranscript({ turns: [], interrupted: false })

    expect(isDirty({ turns: [], interrupted: false, autoApprove: false }, stored)).toBe(false)
  })
})
