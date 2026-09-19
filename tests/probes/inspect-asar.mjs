import { readFileSync } from 'node:fs'

/**
 * Inspect the asar inventory of a built app.
 *
 * The `files` list in electron-builder.yml is include-based, which is the right default for a
 * distributable but is also easy to get subtly wrong in both directions: too narrow and the app
 * cannot start, too wide and it ships the test suites and scratch directories. This prints both.
 */
const lines = readFileSync(process.argv[2] ?? '.preview/asar-list.txt', 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)

const matches = (needle) => lines.filter((l) => l.includes(needle))
const reCount = (re) => lines.filter((l) => re.test(l)).length

console.log('entries in asar:', lines.length)

console.log('\n--- required (the app cannot start without these) ---')
for (const [label, re] of [
  ['out/main', /^\\?out\\main\\/],
  ['out/preload', /^\\?out\\preload\\/],
  ['out/renderer', /^\\?out\\renderer\\/],
  ['package.json', /^\\?package\.json$/],
  ['resources/', /^\\?resources\\/],
]) {
  const n = reCount(re)
  console.log(`${label.padEnd(16)} ${n > 0 ? 'present' : 'MISSING'}  (${n})`)
}

console.log('\n--- unwanted (must be 0) ---')
for (const needle of [
  '\ntests\\',
  '\ntesting\\',
  '\n.preview',
  '\n.freebuff',
  '\n.kun-canvas',
  '\nconveyor\\modules',
  '\nlib\\main',
  '\napp\\components',
  '\nelectron-builder.yml',
  '\nAGENTS.md',
]) {
  const n = matches(needle).length
  // Anchored at the archive root deliberately. A bare substring search also matches dependency files
  // such as `node_modules/zod/src/v3/tests/...`, which are not ours and are legitimately packed —
  // reporting those as leaks would train the reader to ignore this check.
  const label = needle.replace(/^\n/, '')
  console.log(`${label.padEnd(20)} ${n === 0 ? 'clean' : `LEAK (${n})`}`)
}

console.log('\ndebug maps:', reCount(/\.map$/))
console.log('electron-conveyor entries:', matches('electron-conveyor').length)
console.log('node_modules entries:', reCount(/^\\?node_modules\\/))
