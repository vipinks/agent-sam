/**
 * Verifies the pure composer-command rules: where a slash counts as a command, what a filter matches,
 * which command is hidden on the home screen, and which command a highlighted row stands for.
 *
 * Pure on purpose. These are the decisions the composer's slash picker branches on, and every one of
 * them is a rule about data: a slash in the middle of a sentence must stay text, a description that is
 * not matched is a command the user cannot find by the word they know, and resolving a highlight to
 * the wrong row runs work the user did not ask for. None of that needs a rendered tree to be wrong.
 *
 * What is deliberately *not* here: what each command does. Dispatching is the renderer's side of the
 * seam, and it is tested there — through the real composer, against the real store actions — because
 * a rule suite asserting on a dispatch would be asserting on its own arrangement of the dispatch.
 */
import { strict as assert } from 'node:assert'
import {
  COMPOSER_COMMANDS,
  composerCommandAt,
  filterComposerCommands,
  parseComposerCommand,
  type ComposerCommandId,
} from '../../conveyor/protocol/composer-commands'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

// ---------------------------------------------------------------- the registry

function theRegistryIsTheApprovedSetInFixedOrder() {
  const ids = COMPOSER_COMMANDS.map((command) => command.id)
  assert.deepEqual(
    ids,
    ['new', 'terminal', 'settings', 'mcp', 'skills', 'theme', 'help', 'version'],
    'exactly the approved commands, in the order the picker shows them'
  )

  // Every row carries both halves of what it renders: the word, and the line beside it.
  for (const command of COMPOSER_COMMANDS) {
    assert.equal(command.name.length > 0, true, `${command.id} has a name to type`)
    assert.equal(command.description.length > 0, true, `${command.id} has a description to read`)
  }

  // One command, and only one, is hidden on home — the one that would do nothing there.
  assert.deepEqual(
    COMPOSER_COMMANDS.filter((command) => command.hiddenAtHome === true).map((command) => command.id),
    ['new'],
    'only /new is hidden on the home screen'
  )
  results.push('the registry is the approved eight, in fixed order, with /new alone hidden at home')
}

function anEmptyQueryListsEveryAvailableCommandInOrder() {
  const rows = filterComposerCommands('', { atHome: false })
  assert.deepEqual(
    rows.map((command) => command.id),
    COMPOSER_COMMANDS.map((command) => command.id),
    'a bare slash offers everything, in registry order'
  )

  // The same list object each time: the registry is the source, so a filter cannot reorder it.
  assert.deepEqual(
    rows.map((command) => command.name),
    ['new', 'terminal', 'settings', 'mcp', 'skills', 'theme', 'help', 'version'],
    'the names come back in display order'
  )
  results.push('an empty query lists every available command in fixed display order')
}

// ---------------------------------------------------------------- the token

function aLeadingSlashIsTheOnlySlashThatOpensACommand() {
  const bare = parseComposerCommand('/')
  assert.deepEqual(bare, { start: 0, end: 1, query: '' }, 'a bare slash is a command with an empty query')

  const typed = parseComposerCommand('/theme')
  assert.deepEqual(typed, { start: 0, end: 6, query: 'theme' }, 'the token covers the whole draft')

  // Case is the filter's business, not the parser's: it hands over what was typed.
  assert.equal(parseComposerCommand('/THEME')?.query, 'THEME', 'the query is what was typed, unlowercased')
  results.push('a slash at position zero opens a token, and the token carries the query as typed')
}

function aSlashElsewhereStaysText() {
  const rejected = ['', 'explain this', 'what about /new', 'the path is src/lib/utils', ' /new', 'a/b']

  for (const text of rejected) {
    assert.equal(parseComposerCommand(text), null, `${JSON.stringify(text)} must not open a command`)
  }

  // A space ends the command: `/new please` is a sentence, and an argument grammar is out of scope.
  assert.equal(parseComposerCommand('/new please'), null, 'a space closes the token rather than arguing')
  assert.equal(parseComposerCommand('/theme\tx'), null, 'any whitespace closes it, not only a space')
  results.push('a mid-draft slash, a leading space before it, and a space after the word all stay literal')
}

// ---------------------------------------------------------------- the filter

function theFilterMatchesNamesAndDescriptions() {
  const named = filterComposerCommands('theme', { atHome: false })
  assert.deepEqual(
    named.map((command) => command.id),
    ['theme'],
    'a name matches itself'
  )

  // Case-insensitive on the name...
  assert.deepEqual(
    filterComposerCommands('THEME', { atHome: false }).map((command) => command.id),
    ['theme'],
    'the name match ignores case'
  )

  // ...and on the description, which is how a user who does not know the word reaches the command.
  assert.deepEqual(
    filterComposerCommands('dark', { atHome: false }).map((command) => command.id),
    ['theme'],
    'a word only the description has still finds its command'
  )
  assert.deepEqual(
    filterComposerCommands('MCP', { atHome: false }).map((command) => command.id),
    ['mcp'],
    'description matching ignores case too'
  )

  // A substring matches in the middle of a word, which is what makes the filter usable while typing.
  assert.ok(
    filterComposerCommands('ers', { atHome: false }).some((command) => command.id === 'settings'),
    'a partial word finds its command'
  )
  results.push('the filter matches names and descriptions, case-insensitively, on substrings')
}

function aQueryThatMatchesNothingOffersNothing() {
  assert.deepEqual(filterComposerCommands('zzzz', { atHome: false }), [], 'no match offers no rows')

  // And the set a query searches is the registry: nothing is invented by filtering.
  const everything = filterComposerCommands('', { atHome: false })
  assert.equal(
    everything.every((command) => COMPOSER_COMMANDS.includes(command)),
    true,
    'filtering narrows the registry rather than building rows of its own'
  )
  results.push('a query that matches nothing offers nothing, and filtering never invents a row')
}

// ---------------------------------------------------------------- availability

function availabilityHidesNewOnHome() {
  const atHome = filterComposerCommands('', { atHome: true })
  assert.deepEqual(
    atHome.map((command) => command.id),
    ['terminal', 'settings', 'mcp', 'skills', 'theme', 'help', 'version'],
    'every command but /new is offered on home'
  )

  // Hidden means not offered, which is a different fact from "did not match": the query that names it
  // still finds nothing there, because the command could not run if it did.
  assert.deepEqual(filterComposerCommands('new', { atHome: true }), [], '/new cannot be reached on home by name')
  assert.deepEqual(
    filterComposerCommands('new', { atHome: false }).map((command) => command.id),
    ['new'],
    'and is reachable in a conversation'
  )

  // Hiding does not reorder what is left: the rows are still the registry's order, minus one.
  const ids: ComposerCommandId[] = atHome.map((command) => command.id)
  assert.deepEqual(
    ids,
    COMPOSER_COMMANDS.map((command) => command.id).filter((id) => id !== 'new'),
    'the remaining rows keep their registry order'
  )
  results.push('availability hiding removes /new on home without disturbing the order of the rest')
}

// ---------------------------------------------------------------- selection

function theHighlightedRowResolvesToItsCommand() {
  const rows = filterComposerCommands('', { atHome: false })

  // Resolved through the row rather than through a parallel list of ids, so the index the picker holds
  // and the command that runs cannot come from two different orders.
  assert.equal(composerCommandAt(rows, 0), 'new', 'the first row is /new')
  assert.equal(composerCommandAt(rows, 3), 'mcp', 'the fourth row is /mcp')
  assert.equal(composerCommandAt(rows, 7), 'version', 'the last row is /version')

  // No row there is no command, whatever the index: a list that just narrowed leaves the index past
  // its end, and running the row that used to be there would run something nobody highlighted.
  assert.equal(composerCommandAt([], 0), null, 'an empty list resolves to nothing')
  assert.equal(composerCommandAt(rows, 8), null, 'an index past the end resolves to nothing')
  assert.equal(composerCommandAt(rows, -1), null, 'a negative index resolves to nothing')
  results.push('selection resolution returns the highlighted row’s id, and null where there is no row')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('registry', theRegistryIsTheApprovedSetInFixedOrder)
  step('empty query', anEmptyQueryListsEveryAvailableCommandInOrder)
  step('token', aLeadingSlashIsTheOnlySlashThatOpensACommand)
  step('literal slashes', aSlashElsewhereStaysText)
  step('filter', theFilterMatchesNamesAndDescriptions)
  step('no match', aQueryThatMatchesNothingOffersNothing)
  step('availability', availabilityHidesNewOnHome)
  step('selection', theHighlightedRowResolvesToItsCommand)

  console.log(`composer commands: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('COMPOSER COMMANDS TEST FAILED:', err)
  process.exit(1)
}
