import { describe, expect, it } from 'vitest'
import { formatBytes, imageOf } from '@/app/components/workbench/image'

/**
 * The two rules the image branch rests on, without a DOM.
 *
 * `imageOf` is the narrowing the pane does before it renders anything, and the case that matters is the
 * one that is *nearly* an image: a result that claims the kind but has nothing to show must not become
 * an `img` with an undefined source. `formatBytes` is the caption's only number, so its boundaries are
 * pinned rather than left to a render.
 *
 * The pane's own wiring — one `img`, its alt text, the absent field and gutter, the refetch — is in
 * `code-viewer-image.test.tsx`, because only a rendered pane can fail there.
 */

const IMAGE = {
  kind: 'image',
  mime: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA',
  bytes: 2048,
  path: 'C:/w/logo.png',
  baselineMtime: 1,
}

describe('imageOf', () => {
  it('accepts an image result', () => {
    expect(imageOf(IMAGE)).toBe(true)
  })

  it('rejects the text result, and the empty file’s text result', () => {
    // Branched on `kind`, never on whether `content` has any characters in it: a file of zero length is
    // a text file, and reading it as anything else would show a broken picture for an empty buffer.
    expect(imageOf({ path: 'C:/w/app.ts', content: 'const a = 1\n' })).toBe(false)
    expect(imageOf({ path: 'C:/w/empty.ts', content: '' })).toBe(false)
  })

  it('rejects a result that says it is an image but cannot be drawn', () => {
    // The failure this exists for: main's shape without a data URL would render as an `img` whose source
    // is undefined — a broken picture claiming to be a file.
    expect(imageOf({ ...IMAGE, dataUrl: undefined })).toBe(false)
    expect(imageOf({ ...IMAGE, mime: undefined })).toBe(false)
    expect(imageOf({ ...IMAGE, bytes: '2048' })).toBe(false)
    expect(imageOf({ ...IMAGE, kind: 'text' })).toBe(false)
  })

  it('rejects what is not an object at all', () => {
    // A read that has not landed, or a failure: neither is an image, and neither may throw.
    expect(imageOf(undefined)).toBe(false)
    expect(imageOf(null)).toBe(false)
    expect(imageOf('data:image/png;base64,AAAA')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('counts bytes exactly below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('crosses to kilobytes at exactly 1024, and to megabytes at exactly 1 MiB', () => {
    // Both boundaries, because an off-by-one in either direction is invisible in a caption.
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
