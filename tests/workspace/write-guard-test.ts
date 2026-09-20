/**
 * Verifies the pure write-guard decision: may this write proceed, given what we read and what the
 * disk says now?
 *
 * Seeded numbers rather than a filesystem, because the decision is arithmetic over three inputs and
 * the interesting cases are the ones a real directory makes awkward to stage on demand: a file that
 * has since been deleted, a write that explicitly forces, and a caller that never passed a baseline
 * at all. Whether the numbers came from a real `stat` is the module suite's business.
 *
 * The decision has to be exact. A guard that allowed a write it should have refused is the silent
 * overwrite this whole phase exists to remove; a guard that refused a write it should have allowed
 * would make the editor unusable, so both directions are pinned here.
 */
import { strict as assert } from 'node:assert'
import { decideWrite, WRITE_CONFLICT } from '../../conveyor/protocol/write-guard'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

const TEN = 1_700_000_000_000
const ELEVEN = 1_700_000_000_111

// ---------------------------------------------------------------- the unguarded path

function noBaselineIsAllowed() {
  // The agent's `write_file` and the terminal never pass a baseline: they are writing a file they
  // were just asked to write, with nothing to compare against. Their behaviour must be exactly what
  // it was before this phase, so an absent baseline always allows.
  assert.equal(decideWrite({ baselineMtime: null, diskMtime: TEN, force: false }), 'allow')
  assert.equal(decideWrite({ baselineMtime: null, diskMtime: TEN, force: true }), 'allow')

  results.push('a write with no baseline is allowed, whatever the disk says')
}

function noBaselineAndNoFileIsAllowed() {
  // A brand-new file in a brand-new directory: there is no baseline and nothing on disk. That is the
  // ordinary first write, not a conflict.
  assert.equal(decideWrite({ baselineMtime: null, diskMtime: null, force: false }), 'allow')
  results.push('a first write to a path that does not exist yet is allowed')
}

// ---------------------------------------------------------------- the guarded path

function aMatchingBaselineIsAllowed() {
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: TEN, force: false }), 'allow')
  results.push('a write whose baseline still matches the disk is allowed')
}

function aStaleBaselineIsRefused() {
  // The one case this phase is about: someone else wrote the file after we read it.
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: ELEVEN, force: false }), WRITE_CONFLICT)
  results.push('a write whose baseline is stale is refused as a conflict')
}

function aFileThatVanishedIsAConflict() {
  // No mtime on disk is not "unchanged" — it is the disk having moved in the most disruptive way
  // available. Writing here would recreate a file the user may have deleted on purpose.
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: null, force: false }), WRITE_CONFLICT)
  results.push('a file that has since been deleted is a conflict rather than a fresh write')
}

function anOlderDiskIsStillAConflict() {
  // Compared for equality rather than for order: a newer mtime and an older one are both "not what
  // we read", and a rule that only caught newer values would pass a file restored from a backup.
  assert.equal(decideWrite({ baselineMtime: ELEVEN, diskMtime: TEN, force: false }), WRITE_CONFLICT)
  results.push('an mtime that moved backwards is a conflict too, not just a newer one')
}

// ---------------------------------------------------------------- forcing

function forceOverridesAStaleBaseline() {
  // The user's second, deliberate choice: they have seen the banner and want their buffer to win.
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: ELEVEN, force: true }), 'allow')
  results.push('an explicit force overrides a stale baseline')
}

function forceOverridesADeletedFile() {
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: null, force: true }), 'allow')
  results.push('an explicit force also overrides a file that has gone')
}

function forceDoesNotChangeTheOrdinaryCases() {
  // Forcing a write that was going to be allowed anyway must not become something else.
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: TEN, force: true }), 'allow')
  assert.equal(decideWrite({ baselineMtime: null, diskMtime: null, force: true }), 'allow')
  results.push('force changes nothing when the write was already allowed')
}

// ---------------------------------------------------------------- the code

function theConflictCodeIsStable() {
  // The renderer branches on this string, so it is pinned here rather than left to whoever spells it
  // next: a rename would otherwise fail silently in the UI as a generic save error.
  assert.equal(WRITE_CONFLICT, 'WRITE_CONFLICT')
  // And the decision returns that same string, so a caller cannot compare against a different one.
  assert.equal(decideWrite({ baselineMtime: TEN, diskMtime: ELEVEN, force: false }), 'WRITE_CONFLICT')
  results.push('the conflict code is a single pinned string, returned by the decision itself')
}

// ---------------------------------------------------------------- harness

function main() {
  step('no baseline', noBaselineIsAllowed)
  step('no baseline, no file', noBaselineAndNoFileIsAllowed)
  step('matching baseline', aMatchingBaselineIsAllowed)
  step('stale baseline', aStaleBaselineIsRefused)
  step('deleted file', aFileThatVanishedIsAConflict)
  step('older disk', anOlderDiskIsStillAConflict)
  step('force: stale', forceOverridesAStaleBaseline)
  step('force: deleted', forceOverridesADeletedFile)
  step('force: no-op', forceDoesNotChangeTheOrdinaryCases)
  step('code', theConflictCodeIsStable)

  console.log(`write guard: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main()
