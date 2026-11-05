import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The inventory sweep: no arrival or exit ships without its reduced-motion guard.
 *
 * Every animated class string in `app/` is read from the file, not from a render: an overlay that only
 * appears behind an open dialog would otherwise need seven suites to be mounted in the right state
 * before the rule could see it, and a new surface would be invisible until someone remembered to add
 * its suite. The sweep is deliberately blunt — any line naming `animate-in`, `animate-out`,
 * `animate-pulse` or `animate-bounce` must also name `motion-reduce:animate-none` — because the
 * failure it prevents is the one that is easy to miss and expensive to notice: motion a reader asked
 * not to see.
 *
 * The four are the utilities `tw-animate-css` ships that move on their own. `pulse` and `bounce` were
 * added when the chat's working row gained one: a pulsing dot is motion like any other arrival, and a
 * sweep that only knew the two overlay families would have let the next one ship ungated.
 *
 * Lines, not AST: every class string in this repo is one line, and a class split across lines would be
 * reported here as ungated rather than silently skipped. A surface that genuinely needs to build its
 * animation from several lines has to say why beside the guard, and this rule is where that discussion
 * starts.
 *
 * The stylesheet is not read because there is no new stylesheet: `tw-animate-css` is the only source of
 * these utilities, and every one of them is named in a `.tsx` class string — which is exactly what this
 * file can see.
 */

const APP = resolve(process.cwd(), 'app')

/** Every `.tsx` under `app/`, in a stable order so a failure's first line is stable too. */
function componentFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...componentFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(path)
  }
  return files.sort()
}

describe('the motion inventory', () => {
  it('gives every animate-in, animate-out, animate-pulse and animate-bounce class string an effective reduced-motion guard', () => {
    const ungated: string[] = []

    for (const file of componentFiles(APP)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (!/animate-(?:in|out|pulse|bounce)/.test(line)) return
          const where = `${relative(process.cwd(), file)}:${index + 1}`

          // The base guard: every animated class string names it, so a surface that ships without any
          // reduced-motion story is caught before a data variant can be argued about.
          if (!line.includes('motion-reduce:animate-none')) ungated.push(where)

          // And the effective guard. `motion-reduce:animate-none` is one class; a class string gated on
          // an attribute is class-plus-attribute, so on specificity alone the attribute wins and the
          // animation plays anyway. Every data-driven animation therefore needs the stacked variant —
          // `motion-reduce:data-[…]:animate-none` — which matches the same element shape.
          for (const match of line.matchAll(/data-\[[^\]]+\]:animate-(?:in|out|pulse|bounce)/g)) {
            const variant = match[0].replace(/:animate-(?:in|out|pulse|bounce)$/, '')
            if (!line.includes(`motion-reduce:${variant}:animate-none`)) {
              ungated.push(`${where} (${variant} needs motion-reduce:${variant}:animate-none)`)
            }
          }
        })
    }

    expect(ungated).toEqual([])
  })
})
