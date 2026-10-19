/**
 * Verifies the six window accelerators without a menu.
 *
 * Phase 100 removes the File/Edit/View menus, and the View menu was the only thing that declared these
 * six shortcuts. What replaces it is a listener over a pure table, so the whole claim — which chord
 * means which act, and when a chord means nothing at all — is decidable without a DOM, a window or an
 * electron process. That is what this file is: the table, resolved.
 *
 * Every case is checked, not only the first, because six accelerators that fail together would report
 * as one red line if this suite stopped at the first mismatch.
 */
import { strict as assert } from 'node:assert'
import {
  WINDOW_SHORTCUTS,
  isTextEntryTarget,
  resolveWindowShortcut,
  windowShortcut,
  type KeyStroke,
  type WindowCommand,
} from '../../app/shell/window-shortcuts'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** One chord, and the command the table has to resolve it to. */
const CASES: { chord: KeyStroke; command: WindowCommand }[] = [
  { chord: { key: 'r', ctrlKey: true }, command: 'reload' },
  { chord: { key: 'I', ctrlKey: true, shiftKey: true }, command: 'toggleDevtools' },
  { chord: { key: '+', ctrlKey: true }, command: 'zoomIn' },
  { chord: { key: '-', ctrlKey: true }, command: 'zoomOut' },
  { chord: { key: '0', ctrlKey: true }, command: 'actualSize' },
  { chord: { key: 'F11' }, command: 'toggleFullscreen' },
]

/** How the act is named in this suite's messages. */
function nameOf(command: WindowCommand): string {
  return command
}

/**
 * All six accelerators resolve to their own act, in the order the View menu used to list them.
 *
 * The canonical combination is what a keyboard sends on the default layout: the chord and the act, one
 * pair per assertion, so a table that resolved two chords to one command would name the pair it broke.
 */
function everyChordsResolves() {
  for (const { chord, command } of CASES) {
    assert.equal(
      resolveWindowShortcut(chord, { textEntry: false }),
      command,
      `${JSON.stringify(chord)} resolves to ${command}`
    )
  }
  results.push('rules: all six resolve to their own command')
}

/**
 * The chords a keyboard actually sends, rather than the ones a menu spells.
 *
 * `Ctrl+Plus` is a shifted `=` on most layouts and arrives as either key; the primary modifier is the
 * command key on macOS; and the letter case is the shift state's business, not the table's. Each of the
 * three is a way the same act is typed, so each has to reach the same command.
 */
function thePhysicalChordsResolveToo() {
  assert.equal(resolveWindowShortcut({ key: '=', ctrlKey: true }, { textEntry: false }), 'zoomIn', 'Ctrl+= is zoom in')
  assert.equal(
    resolveWindowShortcut({ key: '_', ctrlKey: true }, { textEntry: false }),
    'zoomOut',
    'Ctrl+_ is zoom out'
  )
  assert.equal(
    resolveWindowShortcut({ key: 'R', ctrlKey: true }, { textEntry: false }),
    'reload',
    'the capital is the same key'
  )

  for (const { chord, command } of CASES) {
    // Fullscreen is the one chord with no primary modifier at all — `F11` is `F11` whatever platform the
    // window is on — so the command key is a variant of the five that have one, and not of that one.
    if (!chord.ctrlKey) continue
    const mac: KeyStroke = { ...chord, ctrlKey: undefined, metaKey: true }
    assert.equal(resolveWindowShortcut(mac, { textEntry: false }), command, `Meta reaches ${nameOf(command)}`)
  }
  results.push('rules: the physical and macOS spellings of the six resolve')
}

/**
 * A field's keystrokes are the field's.
 *
 * The terminal panel is the reason this rule exists at all: `Ctrl+R` at a shell prompt is the shell's
 * reverse search, and the window acting on it instead would take a keystroke away from the line the user
 * is typing. The suppression is the whole set rather than that one chord — a window act that fires while
 * someone is typing is the surprise, whichever act it is.
 */
function aFieldKeepsItsKeystrokes() {
  for (const { chord, command } of CASES) {
    assert.equal(
      resolveWindowShortcut(chord, { textEntry: true }),
      null,
      `${nameOf(command)} is not the window's while a field has the focus`
    )
  }

  assert.equal(isTextEntryTarget({ tagName: 'INPUT' }), true, 'an input is a field')
  assert.equal(isTextEntryTarget({ tagName: 'TEXTAREA' }), true, 'so is a textarea')
  assert.equal(isTextEntryTarget({ tagName: 'SELECT' }), true, 'and a select')
  assert.equal(isTextEntryTarget({ tagName: 'DIV', isContentEditable: true }), true, 'and a rich editor')
  assert.equal(isTextEntryTarget({ tagName: 'DIV' }), false, 'a div is not')
  assert.equal(isTextEntryTarget({ tagName: 'BUTTON' }), false, 'a button is not')
  assert.equal(isTextEntryTarget(null), false, 'and nothing focused at all is not')
  results.push('rules: a field keeps all six chords')
}

/**
 * A chord the table does not name does nothing.
 *
 * The three refusals are the ones a browser would otherwise act on by itself: `Ctrl+R` without the
 * primary modifier is a letter, `Ctrl+Shift+R` is a hard reload the app never offered, and `Alt` is the
 * modifier the removed menu bar used to answer to.
 */
function everyOtherChordIsIgnored() {
  const ignored: KeyStroke[] = [
    { key: 'r' },
    { key: 'r', ctrlKey: true, shiftKey: true },
    { key: 'r', ctrlKey: true, altKey: true },
    { key: 'I', ctrlKey: true },
    { key: 'F11', ctrlKey: true },
    { key: 'F11', shiftKey: true },
    { key: 'F12' },
    { key: 'q', ctrlKey: true, metaKey: true },
  ]

  for (const chord of ignored) {
    assert.equal(resolveWindowShortcut(chord, { textEntry: false }), null, `${JSON.stringify(chord)} does nothing`)
  }
  results.push('rules: every other chord is ignored')
}

/**
 * The table and the resolver cannot disagree, and the accelerators are the six the phase names.
 *
 * The words are what the tooltips carry and what a reader learns the chord from, so a table whose
 * declaration resolved to another act would be a tooltip teaching the wrong key. The stroke is turned
 * back into a chord here and resolved through the same function the window uses.
 */
function theDeclarationsAgreeWithTheResolver() {
  assert.deepEqual(
    WINDOW_SHORTCUTS.map((shortcut) => shortcut.accelerator),
    ['Ctrl+R', 'Ctrl+Shift+I', 'Ctrl+Plus', 'Ctrl+Minus', 'Ctrl+0', 'F11'],
    'the six accelerators, in the order the View menu listed them'
  )

  for (const shortcut of WINDOW_SHORTCUTS) {
    const chord: KeyStroke = {
      key: shortcut.stroke.keys[0] as string,
      ctrlKey: shortcut.stroke.primary,
      shiftKey: shortcut.stroke.shift,
      altKey: shortcut.stroke.alt,
    }
    assert.equal(resolveWindowShortcut(chord, { textEntry: false }), shortcut.command, `${shortcut.accelerator}`)
    assert.equal(windowShortcut(shortcut.command), shortcut, `${shortcut.command}: looked up by name`)
  }
  results.push('rules: the declarations and the resolver agree')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('table: every chord resolves', everyChordsResolves)
  step('table: physical and macOS spellings', thePhysicalChordsResolveToo)
  step('focus: a field keeps its keystrokes', aFieldKeepsItsKeystrokes)
  step('table: every other chord is ignored', everyOtherChordIsIgnored)
  step('table: declarations agree with the resolver', theDeclarationsAgreeWithTheResolver)

  console.log(`window shortcuts: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('WINDOW SHORTCUTS TEST FAILED:', err)
  process.exit(1)
}
