/**
 * The hairline between two of the titlebar row's functional groups.
 *
 * A rule rather than a wrapper element, and deliberately: the buttons stay children of the row, so a
 * group cannot take one of them out of the tab order or out of the order a reader walks them in. What
 * says "these belong together" is the spacing and the rule; what holds them together is nothing. The
 * mark is a data attribute because a separator and a divider are the same element in a snapshot, and a
 * test that had to guess which one it was looking at would be a test of the guess.
 *
 * Its own module since Phase 100 because three groups now draw their own leading rule — the update badge
 * and the terminal toggle each render only while they have something to show, and a rule that arrives
 * with its group is the only way an absent group leaves no double seam behind. One copy of the rule is
 * the point: a second spelling of the hairline is a second rule that can drift from this one.
 *
 * A plain span since Phase 100 turn 2, rather than the shared `Separator`, and the geometry above is the
 * reason. The primitive's vertical form carries `data-[orientation=vertical]:h-full`, which outranks any
 * `h-*` passed alongside it on specificity — two simple selectors against one — so the height that
 * applied was `100%`, not the fixed measure. Against a cluster whose own height is its content's, a
 * percentage height is indefinite and resolves to `auto`, and an empty box at `auto` height is zero tall:
 * the rule sat in the tree, in the right position, and painted nothing. The fixed height, the one-pixel
 * width and `self-center` are therefore written here, on the element that is drawn, where no shared
 * primitive can outrank them. The paint is the foreground's own ink at 35 percent, so the hairline reads
 * against the bar in light and dark and in every theme instead of borrowing a surface token.
 */
export function TitlebarGroupSeparator() {
  return (
    <span
      aria-hidden="true"
      data-titlebar-separator=""
      className="mx-1.5 h-5 w-px shrink-0 self-center bg-foreground/35"
    />
  )
}
