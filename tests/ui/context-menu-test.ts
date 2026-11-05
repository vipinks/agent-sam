/**
 * The two native context menus, as data: which region offers what, in which order, and what a caller
 * may hand the command.
 *
 * The menu itself is a native window, so nothing here asserts that one appears — that is the witness's
 * to see. What a suite can hold is the half that decides what the window contains, and the half that
 * decides whether a click on an unmarked region can raise one at all: the template is a plain array and
 * the payload is a schema, so both are checked without electron, without a window and without a DOM.
 *
 * The payload case is the one that keeps a menu from opening wherever the platform last put one. All
 * three fields are required, and they are the event's own coordinates: a payload missing `x` or `y` is
 * refused rather than defaulted, and a region this build does not draw is refused rather than answered
 * with another region's menu.
 */
import { strict as assert } from 'node:assert'
import {
  CONTEXT_MENU_REGIONS,
  ContextMenuInput,
  contextMenuTemplate,
  type ContextMenuItem,
} from '../../conveyor/protocol/context-menu'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** The separator, named once so the expected lists below read as menus rather than as object shapes. */
const RULE: ContextMenuItem = { type: 'separator' }

// ---------------------------------------------------------------- the templates

/**
 * The composer's menu: what an editable field offers, grouped by what the items do.
 *
 * The history pair, then the clipboard, then selection — two rules and eight entries. Native roles
 * rather than labels, in the platform's own order, so the platform provides the words, the
 * accelerators and the actions themselves.
 */
function theComposerOffersTheStandardSixInTwoGroups() {
  assert.deepEqual(
    contextMenuTemplate('composer'),
    [
      { role: 'undo' },
      { role: 'redo' },
      RULE,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      RULE,
      { role: 'selectAll' },
    ],
    'the composer offers undo, redo, cut, copy, paste and select-all, with a rule between the groups'
  )
  results.push('the composer offers the standard six in two groups: history, clipboard, selection')
}

/**
 * The chat's menu: a copy, and nothing else.
 *
 * A right-click on selected text is a question about the words under the pointer. Editing, deleting
 * and regenerating a message are acts on a turn, and they stay on the controls the bubble already
 * draws at its bottom rather than being hidden behind a gesture nothing advertises.
 */
function theChatOffersCopyOnly() {
  assert.deepEqual(contextMenuTemplate('chat'), [{ role: 'copy' }], 'the chat offers copy and nothing else')
  results.push('the chat offers a single copy item')
}

/**
 * Both templates are made of native roles and separators, and of nothing else.
 *
 * The shape assertion is what keeps a hand-written label or an inline `click` out of the table: an item
 * carrying its own wording would not be localized by the platform, and one carrying its own handler
 * would be a second implementation of an action the role already performs.
 */
function everyItemIsANativeRoleOrARule() {
  for (const region of CONTEXT_MENU_REGIONS) {
    for (const item of contextMenuTemplate(region)) {
      const keys = Object.keys(item).sort()
      const expected = 'role' in item ? ['role'] : ['type']
      assert.deepEqual(
        keys,
        expected,
        `${region}: an item carries only its role or its type, never a label or a handler`
      )
    }
  }
  results.push('every item is a native role or a separator, never a label or an inline handler')
}

// ---------------------------------------------------------------- the payload

/**
 * The payload the command takes: three required fields and no optionals.
 *
 * A menu needs a position to be a menu at the pointer, so `x` and `y` are required rather than
 * defaulted — and the region is an enum, so a caller naming a region this build does not draw is
 * refused at the boundary instead of being answered with some other region's items.
 */
function thePayloadRequiresARegionAndBothCoordinates() {
  const good = ContextMenuInput.safeParse({ region: 'composer', x: 120, y: 240 })
  assert.equal(good.success, true, 'a complete payload parses')
  assert.deepEqual(good.success ? good.data : null, { region: 'composer', x: 120, y: 240 })

  const chat = ContextMenuInput.safeParse({ region: 'chat', x: 0, y: 0 })
  assert.equal(chat.success, true, 'zero is a coordinate, not an absence')

  for (const missing of ['region', 'x', 'y'] as const) {
    const payload: Record<string, unknown> = { region: 'chat', x: 1, y: 2 }
    delete payload[missing]
    assert.equal(ContextMenuInput.safeParse(payload).success, false, `a payload without ${missing} is refused`)
  }

  results.push('the payload requires the region and both coordinates, and zero is a coordinate')
}

/** An unknown region is a zod rejection, which is what makes an unmarked region invoke nothing. */
function anUnknownRegionIsRefused() {
  const rejected = ContextMenuInput.safeParse({ region: 'explorer', x: 10, y: 20 })
  assert.equal(rejected.success, false, 'a region no template answers is refused')
  assert.equal(ContextMenuInput.safeParse({ region: '', x: 10, y: 20 }).success, false, 'and so is an empty one')
  assert.equal(ContextMenuInput.safeParse({ region: 'Chat', x: 10, y: 20 }).success, false, 'the enum is exact')
  results.push('an unknown region is a zod rejection')
}

// ---------------------------------------------------------------- harness

function main() {
  step('template: composer', theComposerOffersTheStandardSixInTwoGroups)
  step('template: chat', theChatOffersCopyOnly)
  step('template: items', everyItemIsANativeRoleOrARule)
  step('payload: fields', thePayloadRequiresARegionAndBothCoordinates)
  step('payload: region', anUnknownRegionIsRefused)

  console.log(`context menu: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

try {
  main()
} catch (err) {
  console.error('CONTEXT MENU TEST FAILED:', err)
  process.exit(1)
}
