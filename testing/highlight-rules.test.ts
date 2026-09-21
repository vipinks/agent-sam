import { describe, expect, it } from 'vitest'
import {
  EXTENSION_LANGUAGES,
  MAX_HIGHLIGHT_BYTES,
  PLAINTEXT,
  SYNTAX_LANGUAGES,
  SYNC_HIGHLIGHT_BYTES,
  createHighlightMemo,
  editorHighlightPlan,
  extensionOf,
  highlightPlan,
  languageForPath,
  skipNote,
  utf8Bytes,
} from '@/app/components/workbench/highlight'

/**
 * The highlighter's rules, tested without a DOM.
 *
 * Which language a path is, whether a file is worth tokenizing at all, and whether the memo holds a
 * result are decisions rather than rendering — and the first of them is the one that fails quietly,
 * since the wrong language still produces plausible-looking spans and an unregistered name throws only
 * when a file is opened. They live in `highlight.ts` so they can be asserted here by calling a
 * function, and so the component is left holding only the state and the two render branches.
 *
 * `languageForPath` is a *registered-language* lookup rather than an extension-to-label table: every
 * value in the map is a name highlight.js actually knows, which is pinned below so the map and the
 * registration cannot drift apart.
 */

/** Content of exactly `bytes` UTF-8 bytes, in a language that is highlighted. */
function phpOfBytes(bytes: number): string {
  const header = '<?php\n'
  return header + 'x'.repeat(Math.max(0, bytes - header.length))
}

describe('a path’s language', () => {
  it('maps the extensions of every language the viewer highlights', () => {
    expect(languageForPath('C:/work/index.php')).toBe('php')
    expect(languageForPath('C:/work/app.ts')).toBe('typescript')
    expect(languageForPath('C:/work/view.tsx')).toBe('typescript')
    expect(languageForPath('C:/work/main.js')).toBe('javascript')
    expect(languageForPath('C:/work/button.jsx')).toBe('javascript')
    expect(languageForPath('C:/work/package.json')).toBe('json')
    expect(languageForPath('C:/work/README.md')).toBe('markdown')
    expect(languageForPath('C:/work/app.css')).toBe('css')
    expect(languageForPath('C:/work/index.html')).toBe('xml')
    expect(languageForPath('C:/work/icon.svg')).toBe('xml')
    expect(languageForPath('C:/work/train.py')).toBe('python')
  })

  it('ignores case, because a Windows path arrives in whatever case it was written', () => {
    expect(languageForPath('C:/work/INDEX.PHP')).toBe('php')
    expect(languageForPath('C:/work/App.TSX')).toBe('typescript')
    expect(languageForPath('C:/work/README.MD')).toBe('markdown')
    expect(languageForPath('c:\\work\\train.PY')).toBe('python')
  })

  it('falls back to plaintext for an extension it does not know', () => {
    expect(languageForPath('C:/work/archive.zip')).toBe(PLAINTEXT)
    expect(languageForPath('C:/work/notes.rst')).toBe(PLAINTEXT)
    expect(languageForPath('C:/work/app.pyc')).toBe(PLAINTEXT)
  })

  it('falls back to plaintext when there is no extension at all', () => {
    expect(languageForPath('C:/work/Makefile')).toBe(PLAINTEXT)
    expect(languageForPath('C:/work/LICENSE')).toBe(PLAINTEXT)
    expect(languageForPath('C:/work/folder/file')).toBe(PLAINTEXT)
    // A leading dot names a hidden file rather than an extension.
    expect(languageForPath('C:/work/.gitignore')).toBe(PLAINTEXT)
    // A trailing dot has an empty extension.
    expect(languageForPath('C:/work/notes.')).toBe(PLAINTEXT)
  })

  it('reads the extension from the file name, not from a dot in a parent directory', () => {
    const dotted = 'C:/work/sam-ai.v2.1/Makefile'
    expect(languageForPath(dotted)).toBe(PLAINTEXT)

    const dottedWithExtension = 'C:/work/my.project/app.ts'
    expect(languageForPath(dottedWithExtension)).toBe('typescript')
  })

  /**
   * The drift guard. `languageForPath` answers with a name that is handed straight to highlight.js, so
   * a typo in the map would not be a wrong colour — it would throw when that file was opened. Every
   * value in the map, and the fallback, must be a language this build actually registers.
   */
  it('answers only with languages that are registered', () => {
    const registered = new Set(SYNTAX_LANGUAGES)

    for (const language of Object.values(EXTENSION_LANGUAGES)) {
      expect(registered.has(language), `the map names ${language}, which is not registered`).toBe(true)
    }
    // The fallback is a highlight.js language too, not a magic string: `plaintext` is registered so a
    // path with no extension still goes through the same one code path.
    expect(registered.has(PLAINTEXT)).toBe(true)
  })

  it('registers exactly the eight languages the viewer covers, and no more', () => {
    expect([...SYNTAX_LANGUAGES].sort()).toEqual(
      ['css', 'javascript', 'json', 'markdown', 'php', 'plaintext', 'python', 'typescript', 'xml'].sort()
    )
  })

  it('splits an extension off the last segment only', () => {
    expect(extensionOf('C:/work/app.ts')).toBe('ts')
    expect(extensionOf('C:/work/Makefile')).toBe('')
    expect(extensionOf('C:/work/.gitignore')).toBe('')
  })
})

describe('the byte measure', () => {
  it('counts ASCII as one byte each', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('')).toBe(0)
  })

  it('counts the bytes a multi-byte character actually occupies', () => {
    // The point of measuring rather than reading `.length`: a file of emoji is four times the bytes
    // its length suggests, and the cap is about the work tokenizing will do.
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('→')).toBe(3)
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('a😀b')).toBe(6)
  })
})

describe('whether to highlight', () => {
  it('highlights an ordinary file synchronously', () => {
    expect(highlightPlan('C:/work/app.php', phpOfBytes(1024))).toEqual({ mode: 'sync', language: 'php' })
  })

  it('does not highlight a language it does not know', () => {
    expect(highlightPlan('C:/work/notes.rst', 'anything')).toEqual({ mode: 'plain', reason: 'plaintext' })
  })

  it(`stays synchronous at exactly ${SYNC_HIGHLIGHT_BYTES} bytes and defers above it`, () => {
    expect(highlightPlan('C:/work/app.php', phpOfBytes(SYNC_HIGHLIGHT_BYTES))).toEqual({
      mode: 'sync',
      language: 'php',
    })
    expect(highlightPlan('C:/work/app.php', phpOfBytes(SYNC_HIGHLIGHT_BYTES + 1))).toEqual({
      mode: 'async',
      language: 'php',
    })
  })

  it(`still highlights at exactly ${MAX_HIGHLIGHT_BYTES} bytes`, () => {
    expect(highlightPlan('C:/work/app.php', phpOfBytes(MAX_HIGHLIGHT_BYTES))).toEqual({
      mode: 'async',
      language: 'php',
    })
  })

  it('skips a file above the cap, and says how big it is', () => {
    const plan = highlightPlan('C:/work/app.php', phpOfBytes(MAX_HIGHLIGHT_BYTES + 1))

    expect(plan.mode).toBe('plain')
    // The reason is what the viewer words the note from — never the size alone.
    expect(plan).toMatchObject({ reason: 'too-large' })
    expect(plan.mode === 'plain' && plan.reason === 'too-large' && plan.bytes).toBe(MAX_HIGHLIGHT_BYTES + 1)
  })

  it('measures the cap in bytes, so a multi-byte file is not underestimated', () => {
    // One character past half a megabyte of characters, which is double that in bytes: over the cap,
    // though `.length` says otherwise. The off-by-one is deliberate — the boundary itself is asserted
    // above, and this case is about the measure, not the edge.
    const heavy = '😀'.repeat(MAX_HIGHLIGHT_BYTES / 4 + 1)
    expect(heavy.length).toBeLessThan(MAX_HIGHLIGHT_BYTES)
    expect(utf8Bytes(heavy)).toBeGreaterThan(MAX_HIGHLIGHT_BYTES)
    expect(highlightPlan('C:/work/app.php', heavy)).toMatchObject({ mode: 'plain', reason: 'too-large' })
  })
})

describe('the editor’s plan', () => {
  /**
   * The rule the edit-mode backdrop hangs on.
   *
   * It takes the size rather than the text because the editor's only question about a file is how big
   * it is: whether the bytes the buffer holds are worth tokenizing at all. Answering it from a number
   * is what keeps the rule callable at the boundary — a 512 KB string to ask about 512 KB of bytes
   * would be a fixture paying for what the rule is about.
   */
  it('highlights an ordinary file, in the band its size puts it in', () => {
    expect(editorHighlightPlan('C:/work/app.php', 1024)).toEqual({ mode: 'sync', language: 'php' })
    expect(editorHighlightPlan('C:/work/app.php', SYNC_HIGHLIGHT_BYTES + 1)).toEqual({
      mode: 'async',
      language: 'php',
    })
  })

  it(`highlights a file of exactly ${MAX_HIGHLIGHT_BYTES} bytes and skips the one past it`, () => {
    expect(editorHighlightPlan('C:/work/app.php', MAX_HIGHLIGHT_BYTES)).toEqual({ mode: 'async', language: 'php' })

    const over = editorHighlightPlan('C:/work/app.php', MAX_HIGHLIGHT_BYTES + 1)
    expect(over).toMatchObject({ mode: 'plain', reason: 'too-large', bytes: MAX_HIGHLIGHT_BYTES + 1 })
    // The editor's note is worded from the same object the read view's is, so the cap is named once.
    expect(skipNote(over)).toMatch(/512 KB/)
  })

  it('does not highlight a language it does not know, however small the file', () => {
    expect(editorHighlightPlan('C:/work/notes.rst', 12)).toEqual({ mode: 'plain', reason: 'plaintext' })
  })

  /**
   * The drift guard, and the reason the rule shares `highlightPlan`'s decision rather than restating
   * it: the editor and the read view must never disagree about the same file. Size arriving as a
   * number and size arriving as text are two spellings of one question.
   */
  it('answers exactly what highlightPlan answers, for the same file', () => {
    const at = (bytes: number) => utf8Bytes(phpOfBytes(bytes))

    for (const bytes of [1024, SYNC_HIGHLIGHT_BYTES + 1, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_BYTES + 1]) {
      expect(editorHighlightPlan('C:/work/app.php', at(bytes))).toEqual(
        highlightPlan('C:/work/app.php', phpOfBytes(bytes))
      )
    }
  })
})

describe('the note', () => {
  it('says nothing when the file was highlighted or was simply not a code language', () => {
    expect(skipNote({ mode: 'sync', language: 'php' })).toBeNull()
    expect(skipNote({ mode: 'async', language: 'php' })).toBeNull()
    expect(skipNote({ mode: 'plain', reason: 'plaintext' })).toBeNull()
  })

  it('explains a skipped file by naming the cap, in the units the cap is in', () => {
    const note = skipNote({ mode: 'plain', reason: 'too-large', bytes: 900_000, limit: MAX_HIGHLIGHT_BYTES })
    expect(note).toMatch(/not highlighted/i)
    expect(note).toMatch(/512 KB/)
  })
})

describe('the memo', () => {
  /** A memo over a counting compute, so "did not tokenize again" is observable. */
  function counting(limit?: number) {
    const calls: string[] = []
    const memo = createHighlightMemo((content, language) => {
      calls.push(`${language}:${content}`)
      return `<tokens>${content}</tokens>`
    }, limit)

    return { memo, calls }
  }

  it('tokenizes once for the same path and content, however often it is asked', () => {
    const { memo, calls } = counting()

    const first = memo.get('C:/work/app.php', 'code', 'php')
    const second = memo.get('C:/work/app.php', 'code', 'php')

    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
  })

  it('tokenizes again when the content changed, because it is different code', () => {
    const { memo, calls } = counting()

    memo.get('C:/work/app.php', 'one', 'php')
    memo.get('C:/work/app.php', 'two', 'php')

    expect(calls).toHaveLength(2)
  })

  it('keeps both files after a tab switch, which is the whole point of keying by path', () => {
    const { memo, calls } = counting()

    memo.get('C:/work/a.php', 'a', 'php')
    memo.get('C:/work/b.php', 'b', 'php')
    // Back to the first file, unchanged: no second tokenize.
    memo.get('C:/work/a.php', 'a', 'php')

    expect(calls).toHaveLength(2)
  })

  it('drops the least recently used entry rather than growing without bound', () => {
    const { memo, calls } = counting(2)
    const a = 'C:/work/a.php'
    const b = 'C:/work/b.php'

    memo.get(a, 'a', 'php') // 1
    memo.get(b, 'b', 'php') // 2
    // Reading `a` again makes it the most recently used, so `b` becomes the one to evict.
    memo.get(a, 'a', 'php')
    memo.get('C:/work/c.php', 'c', 'php') // 3, evicting `b`
    const afterC = calls.length

    // `a` was touched most recently, so it survived the eviction.
    memo.get(a, 'a', 'php')
    expect(calls.length).toBe(afterC)
    // `b` was the least recently used, so it is the one that went.
    memo.get(b, 'b', 'php')
    expect(calls.length).toBe(afterC + 1)
  })
})
