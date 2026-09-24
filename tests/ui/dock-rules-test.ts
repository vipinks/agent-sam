/**
 * The dock's one pure rule: given a row's kind and which resident is already docked, whether a
 * double-click on that row docks the code viewer.
 *
 * Pure by construction, for the reason the other rule suites are: this is the decision the explorer's
 * double-click branches on, so it has to be provable without a window, a bridge, or a rendered tree.
 * The DOM suite then asserts only what a rendered workbench can — that the row reaches this rule and
 * that the dock ends up where the rule says.
 *
 * What is deliberately *not* here: the file the row selects. A double-click selects the row it landed
 * on whatever the rule answers, and that is the row's own click path rather than a decision about the
 * dock.
 */
import { strict as assert } from 'node:assert'
import { CODE_RESIDENT, doubleClickDocksViewer, type ExplorerRowKind } from '../../conveyor/protocol/dock'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- the rows

function aFolderRowNeverDocks() {
  const rows: ExplorerRowKind[] = ['folder']

  // Every dock state, including the two that a file would act on: a folder's double-click is its own
  // expand/collapse and nothing else, so no dock state can make it open a panel.
  for (const docked of [null, CODE_RESIDENT, 'preview', 'terminal']) {
    assert.equal(
      doubleClickDocksViewer(rows[0], docked),
      false,
      `a folder row must not dock with ${String(docked)} docked`
    )
  }

  results.push('a folder row never docks, whatever is docked')
}

function aFileRowDocksUnlessTheCodeViewerIsAlreadyThere() {
  // Rail-only: the ordinary case, and the one the phase exists for.
  assert.equal(doubleClickDocksViewer('file', null), true)

  // Another resident is docked: the double-click is the switch, which is the same move the rail's Code
  // button makes. Asserted for both of the other residents rather than one, so the rule is pinned as
  // "anything that is not the code viewer" instead of "the terminal in particular".
  assert.equal(doubleClickDocksViewer('file', 'preview'), true)
  assert.equal(doubleClickDocksViewer('file', 'terminal'), true)

  // Already docked: the panel has nothing to switch to, and toggling it here would put the viewer away
  // — the one outcome a double-click on a file must not have.
  assert.equal(doubleClickDocksViewer('file', CODE_RESIDENT), false)

  results.push('a file row docks unless the code viewer is already the docked resident')
}

async function main() {
  await step('folder rows', aFolderRowNeverDocks)
  await step('file rows', aFileRowDocksUnlessTheCodeViewerIsAlreadyThere)

  console.log(`dock rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('DOCK RULES TEST FAILED:', err)
  process.exit(1)
})
