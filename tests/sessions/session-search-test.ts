/**
 * Verifies the search matching rules and the snippet extractor.
 *
 * The pure half of the search feature, tested directly: main's scan adds file reading to this, but
 * what counts as a match and what a snippet shows is decided here, and those are the rules that
 * would otherwise only be observable through a dialog and a filesystem.
 *
 * The cases are the ones that go wrong quietly: a term with different casing, a term that occurs
 * more often than the snippet budget allows, two matches so close together that the same excerpt
 * would be produced for both, and a match near either end of the text where a naive fixed window
 * would run off it.
 */
import { strict as assert } from 'node:assert'
import {
  conversationText,
  countMatches,
  extractSnippets,
  searchTranscriptText,
  SEARCH_MAX_SNIPPETS,
  SEARCH_MIN_TERM,
  SEARCH_SNIPPET_CHARS,
} from '../../conveyor/protocol/search'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** A conversation with prose in several turns, one of them empty. */
function conversation(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'u1', role: 'user', content: 'the parser drops trailing newlines', steps: [] },
      { id: 'a1', role: 'assistant', content: '', steps: [] },
      {
        id: 'a2',
        role: 'assistant',
        content: 'The parser needs a trim before it splits. Then the parser is fine.',
        steps: [
          {
            callId: 'c1',
            tool: 'read_file',
            args: { path: 'parser.ts' },
            status: 'ok',
            output: 'export function parse() {}',
          },
        ],
      },
      { id: 'u2', role: 'user', content: 'thanks, the parser works now', steps: [] },
    ],
  }
}

// ---------------------------------------------------------------- what is searched

function theProseIsWhatGetsSearched() {
  const text = conversationText(conversation())

  assert.ok(text.includes('the parser drops trailing newlines'), 'user prose is included')
  assert.ok(text.includes('The parser needs a trim'), 'assistant prose is included')
  // A tool result is not what someone means when they search for words they remember reading.
  assert.ok(!text.includes('export function parse'), 'tool output is not part of the searched text')
  assert.ok(!text.includes('parser.ts'), 'tool arguments are not part of the searched text')
  // The empty assistant turn must not leave a gap that shifts the prose around.
  assert.ok(!text.includes('\n\n\n'), 'empty turns collapse rather than leaving a blank section')
  results.push('search covers the prose of every turn, and not tool arguments or output')
}

// ---------------------------------------------------------------- counting

function countingIsCaseInsensitiveAndNonOverlapping() {
  assert.equal(countMatches('Parser parser PARSER', 'parser'), 3, 'casing does not matter')
  assert.equal(countMatches('aaaa', 'aa'), 2, 'occurrences do not overlap')
  // A term of different length changes the non-overlap arithmetic, which is where an off-by-one
  // would hide.
  assert.equal(countMatches('aaaaaa', 'aaa'), 2, 'a longer term still counts without overlap')
  assert.equal(countMatches('nothing to see', 'parser'), 0, 'an absent term counts zero')
  assert.equal(countMatches('parser', ''), 0, 'an empty term counts nothing')
  assert.equal(countMatches('parser', '   '), 0, 'a whitespace-only term counts nothing')
  results.push('matching is case-insensitive, counts each occurrence once, and ignores empty terms')
}

// ---------------------------------------------------------------- snippets

function snippetsAreCentredOnTheMatch() {
  const before = 'x'.repeat(300)
  const after = 'y'.repeat(300)
  const text = `${before} needle ${after}`

  const [snippet] = extractSnippets(text, 'needle')
  assert.ok(snippet, 'a match produces a snippet')
  // Centred: there is context on both sides, so the reader can see where the term came from.
  assert.ok(snippet.includes('x'), 'the snippet carries context from before the match')
  assert.ok(snippet.includes('needle'), 'the snippet contains the term')
  assert.ok(snippet.includes('y'), 'the snippet carries context from after the match')
  // Both sides were cut, so both ends are marked.
  assert.ok(snippet.startsWith('…'), 'a snippet cut on the left says so')
  assert.ok(snippet.endsWith('…'), 'a snippet cut on the right says so')
  // The budget, plus the two ellipses that mark the cuts.
  assert.ok(
    snippet.length <= SEARCH_SNIPPET_CHARS + 2,
    `a snippet stays near the ${SEARCH_SNIPPET_CHARS}-character budget, got ${snippet.length}`
  )
  results.push('a snippet is centred on its match, marked where it was cut, and near the budget')
}

function aMatchAtTheEdgeIsNotCutOff() {
  const opening = `${'needle'} ${'z'.repeat(200)}`
  const [atStart] = extractSnippets(opening, 'needle')
  assert.ok(atStart.startsWith('needle'), 'a match at the start is shown from the start')
  assert.ok(!atStart.startsWith('…'), 'nothing was cut on the left, so there is no left ellipsis')

  const closing = `${'z'.repeat(200)} needle`
  const [atEnd] = extractSnippets(closing, 'needle')
  assert.ok(atEnd.endsWith('needle'), 'a match at the end is shown to the end')
  assert.ok(!atEnd.endsWith('…'), 'nothing was cut on the right, so there is no right ellipsis')
  results.push('a match at either edge of the text is shown whole, with no misleading ellipsis')
}

function snippetsAreOneLineEach() {
  // The term is written in a different case from the text, so this also carries the case-insensitivity
  // rule into the one-line check.
  const text = 'alpha\n\nbeta NEEDLE line\ngamma'
  const [snippet] = extractSnippets(text, 'needle')
  assert.ok(snippet, 'the match is found through the case difference')
  assert.ok(snippet.includes('NEEDLE'), 'the text is shown as written, not as lowercased')
  assert.ok(!snippet.includes('\n'), 'a snippet is a single line, so the row cannot grow')
  // Runs of whitespace collapse to one space, so the preview reads as prose rather than as a file.
  assert.ok(!snippet.includes('  '), 'whitespace runs collapse')
  results.push('a snippet is collapsed to one line, whatever the source layout')
}

function snippetsAreCappedAndDistinct() {
  // Non-repeating text on purpose. With periodic filler (`'needle filler '.repeat(40)`) two different
  // windows produce byte-identical excerpts, because the text itself is identical — that is honest
  // output, not a duplicate, and asserting distinctness over it would be asserting something about
  // the fixture. Numbered filler makes each region genuinely different.
  const long = Array.from({ length: 40 }, (_, i) => `needle number ${i} appears here`).join(' ')

  const snippets = extractSnippets(long, 'needle')
  assert.equal(snippets.length, SEARCH_MAX_SNIPPETS, `at most ${SEARCH_MAX_SNIPPETS} snippets`)
  assert.equal(new Set(snippets).size, snippets.length, 'no snippet is repeated')

  // Two matches close together each produce their own excerpt, and neither repeats the other: the
  // scan resumes where the previous excerpt ended, so a snippet is a different neighbourhood rather
  // than the same words again under a heading that promised more of them.
  const clustered = `${'needle'} ${'filler '.repeat(20)}needle`
  const pair = extractSnippets(clustered, 'needle', 2)
  assert.equal(pair.length, 2, 'two matches apart in the text each produce a snippet')
  assert.notEqual(pair[0], pair[1], 'the second snippet is not a copy of the first')

  // And a genuine cluster — three matches inside one window — is one place, reported once, rather
  // than the same excerpt three times.
  const repeated = extractSnippets('needleneedleneedle', 'needle')
  assert.equal(repeated.length, 1, 'matches inside one window yield a single snippet, not duplicates')

  assert.deepEqual(extractSnippets(long, 'needle', 0), [], 'a zero budget asks for no snippets')
  assert.deepEqual(extractSnippets('no match here', 'needle'), [], 'an absent term yields nothing')
  results.push(`at most ${SEARCH_MAX_SNIPPETS} distinct snippets, one per match, none repeated`)
}

// ---------------------------------------------------------------- the result shape

function theResultCarriesACountAndSnippets() {
  const { matchCount, snippets } = searchTranscriptText(conversationText(conversation()), 'parser')

  // Every occurrence in the conversation, not just the ones the snippets came from — the count is
  // how the panel says "and there are more" without shipping the transcript.
  assert.equal(matchCount, 4, 'the count covers occurrences the snippets do not show')
  assert.ok(snippets.length > 0 && snippets.length <= SEARCH_MAX_SNIPPETS, 'within the budget')
  assert.ok(
    snippets.every((s) => s.toLowerCase().includes('parser')),
    'every snippet actually contains the term'
  )

  // The floor the UI enforces and the floor main enforces are the same number.
  assert.equal(SEARCH_MIN_TERM, 3, 'the minimum term is the documented one')
  results.push('a result carries the full occurrence count plus no more than the snippet budget')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('searched text', theProseIsWhatGetsSearched)
  step('counting', countingIsCaseInsensitiveAndNonOverlapping)
  step('centring', snippetsAreCentredOnTheMatch)
  step('edges', aMatchAtTheEdgeIsNotCutOff)
  step('one line', snippetsAreOneLineEach)
  step('cap', snippetsAreCappedAndDistinct)
  step('result shape', theResultCarriesACountAndSnippets)

  console.log(`session search rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('SESSION SEARCH TEST FAILED:', err)
  process.exit(1)
}
