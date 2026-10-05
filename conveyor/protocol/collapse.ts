/**
 * The decision behind every collapsible section in a transcript.
 *
 * A step's section — the thinking block a turn is writing, or the card of one tool call — is open while
 * the step is in flight, folds the moment the step completes, and stays wherever the user last put it
 * once they have touched it by hand. That is three rules and one exception, and it is the same three
 * rules for both kinds of section, which is why it lives here rather than in either header: a copy of
 * it inside the card and another inside the bubble would be two answers to one question, and the one
 * that drifted would be the one nobody read.
 *
 * The rule is a pure function of its state and the event that just happened, with no store, no clock and
 * no component import, so a renderer can call it while drawing. It is deliberately not a hook: where the
 * state lives — `useState` in the section that draws it — is the component's business, and keeping it
 * out of here is what makes the rule testable without a DOM.
 */

/** The state of one section: what it shows now, and whether the user has claimed it. */
export interface SectionCollapse {
  /** Whether the section's body is shown. */
  expanded: boolean
  /**
   * Whether a manual toggle has been recorded for this section.
   *
   * Set by a toggle in either direction, because both are the user's own decision about a section they
   * are looking at. While it is set the auto rule leaves the section alone entirely: the user opened it
   * to read something, and folding it back under them is the one thing this rule must never do. A new
   * in-flight period is the exception, and it is the one that makes the flag a claim rather than a
   * setting — see `advanceSectionCollapse`.
   */
  manual: boolean
}

/** What can happen to a section between two draws of it. */
export type SectionCollapseEvent =
  /** Its step is in flight: a turn is streaming its prose, or a call is running or waiting to. */
  | 'started'
  /** Its step is over: the turn ended, or the call has an outcome. */
  | 'completed'
  /** The user clicked its header. */
  | 'toggled'

/** A section nothing has happened to yet: folded, and nobody's. */
export const SECTION_FOLDED: SectionCollapse = { expanded: false, manual: false }

/**
 * The state a section mounts in.
 *
 * Read off the step rather than assumed: a section can mount on a step that is already in flight — a
 * card that took its turn while another was being decided, or a transcript reopened mid-run — and
 * opening it a tick late would draw a fold the user never asked for. A section whose step is already
 * over mounts folded, which is what a conversation read back from disk looks like: every step of it is
 * finished, so every section of it is closed until the reader opens one.
 */
export function openingSectionCollapse(inFlight: boolean): SectionCollapse {
  return inFlight ? { expanded: true, manual: false } : SECTION_FOLDED
}

/**
 * Advance one section by the event that just happened to it.
 *
 * A state the event cannot improve is returned as it stands, by reference. That matters because a run
 * ticks the in-flight event repeatedly — once per frame of a stream — and a fresh object per tick would
 * be a re-render per tick for a section that is already where it belongs.
 */
export function advanceSectionCollapse(state: SectionCollapse, event: SectionCollapseEvent): SectionCollapse {
  switch (event) {
    case 'started':
      // New flight, new claim: the manual flag is cleared here rather than on completion, so the
      // section answers to the rule for as long as the step is running and the user still has the last
      // word afterwards.
      return state.expanded && !state.manual ? state : { expanded: true, manual: false }

    case 'completed':
      // The claim is the whole exception. Nothing else about a section survives its step ending: a
      // step that has finished is not the thing the user was watching, and an unconditional fold is
      // what keeps a long transcript's work out of the way of its answers.
      if (state.manual) return state
      return state.expanded ? { expanded: false, manual: false } : state

    case 'toggled':
      return { expanded: !state.expanded, manual: true }
  }
}
