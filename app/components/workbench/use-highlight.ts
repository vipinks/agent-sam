import { useEffect, useMemo, useState } from 'react'
import { highlightMemo, highlightPlan, type HighlightPlan } from './highlight'

/**
 * The React binding for the highlighter.
 *
 * Deliberately thin, and separate from `highlight.ts` for the reason `use-workspace-changes.ts` is
 * separate from `workspace-changes.ts`: the rules are testable without a render, so the component half
 * should hold nothing but the two things a rule cannot express — when the work happens, and what is on
 * screen while it happens.
 *
 * Both thresholds are honoured here rather than in the caller. Under `SYNC_HIGHLIGHT_BYTES` the tokens
 * are part of the render that asked for them, because work that fits in a frame should not be deferred:
 * deferring it would only replace the code with a flash of plain text. Above it the tokenizing is
 * moved off that render, and the plain text stands until the tokens arrive — the viewer stays
 * responsive, and what the user reads is never wrong, only uncoloured for a moment.
 *
 * The pending result is keyed by the path *and* the content it was computed from, not merely by path.
 * Without that, switching from one large file to another would leave the first file's tokens on screen
 * while the second was being tokenized — a moment of confidently wrong code, which is worse than a
 * moment of plain code. Comparing the key makes that state unrepresentable rather than unlikely.
 */
export function useHighlightedCode(
  path: string | null,
  content: string | null
): { plan: HighlightPlan | null; html: string | null } {
  const plan = useMemo(() => (path !== null && content !== null ? highlightPlan(path, content) : null), [path, content])

  // The synchronous case. Memoized per path and content, so a tab switch back to a file that has not
  // changed re-uses its tokens instead of tokenizing it again.
  const syncHtml = useMemo(() => {
    if (plan === null || plan.mode !== 'sync' || path === null || content === null) return null
    return highlightMemo.get(path, content, plan.language)
  }, [plan, path, content])

  const [deferred, setDeferred] = useState<{ path: string; content: string; html: string } | null>(null)

  useEffect(() => {
    if (plan === null || plan.mode !== 'async' || path === null || content === null) {
      // Nothing is pending, so nothing may be held: a file that drops below the threshold, or a switch
      // to one that is not highlighted at all, must not keep the previous file's tokens alive.
      setDeferred(null)
      return
    }

    let cancelled = false

    // A macrotask rather than a microtask, and this is the whole point of the deferral: the render
    // that asked for the tokens completes and the window paints plain text first, so the work happens
    // after the user's interaction has been answered rather than in front of it.
    const handle = setTimeout(() => {
      if (cancelled) return
      setDeferred({ path, content, html: highlightMemo.get(path, content, plan.language) })
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [plan, path, content])

  // The guard that makes a stale result impossible to show, rather than merely unlikely.
  const deferredHtml =
    deferred !== null && deferred.path === path && deferred.content === content ? deferred.html : null

  let html: string | null = null
  if (plan !== null) {
    if (plan.mode === 'sync') html = syncHtml
    else if (plan.mode === 'async') html = deferredHtml
    // `plain` leaves it null: the caller renders the source text, which is the one path that must never
    // become markup.
  }

  return { plan, html }
}
