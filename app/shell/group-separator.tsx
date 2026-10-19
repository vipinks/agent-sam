import { Separator } from '../components/ui/separator'

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
 * the point: a second spelling of `mx-1.5 h-5` is a second hairline that can drift from this one.
 */
export function TitlebarGroupSeparator() {
  return <Separator orientation="vertical" data-titlebar-separator="" className="mx-1.5 h-5" />
}
