// Every position, size and spacing of what sits over Mia's video (#3):
// captions, the Contact button, the cards. ONE place to tune, so the boss's
// "move this, shrink that" is a constant away — the components read these and
// add no numbers of their own.
//
// Units: the embed fills the tour's AIWEB Web Frame, so vw = a fraction of
// the frame's own width, and everything reads the same whatever size the
// frame is published at (1280 CSS px in the current tour, drawn ~0.7x on the
// 1080p kiosk). clamp() keeps fonts sane if the frame is ever very small or
// very large.
//
// Screenshots to compare layouts: node tests/screen/shots.mjs (before/after,
// 1920x1080 and 1080x1920). The "before" values (the layout Alexandre
// commented on, 2026-10-12) are noted inline so going back is one edit.

export const LAYOUT = {
  captions: {
    // Where her caption column starts above the frame's bottom edge,
    // depending on what holds that edge (the turn pill, a banner, or the
    // bigger paused banner). Before: 4.2vw — her caption reached her chin.
    bottomOverPill: "2.8vw",
    bottomOverBanner: "6vw",
    bottomOverPausedBanner: "9vw",
    // Before: "min(88%, 62em)" — her caption spanned most of the frame.
    width: "min(78%, 54em)",
    // Stacked layout only: space between the visitor's caption and hers.
    // Before: 0.5vw — the two boxes nearly touched.
    gap: "1.6vw",
    // Where the visitor's caption goes. A height ("2vw") floats it at the
    // top of the frame, above her head, where it can never crowd her face
    // or her caption. undefined stacks it above hers again (the old
    // layout), `gap` apart — flip this one line after the boss picks.
    visitorTop: "2vw" as string | undefined,
    visitorTopWidth: "min(52%, 36em)",
    visitor: { fontSize: "clamp(12px, 1.7vw, 28px)", lines: 2 },
    mia: { fontSize: "clamp(16px, 2.5vw, 42px)", lines: 2 },
  },

  // The Contact button: give it `top` OR `bottom` (the other undefined).
  // Before: bottom "1.2vw" — it floated at her shoulder, next to the turn
  // pill, mid-screen on the kiosk. Now the frame's top-right corner, out of
  // the caption band but in plain sight (cards still open over it).
  contactButton: {
    right: "2.5%",
    top: "1.2vw" as string | undefined,
    bottom: undefined as string | undefined,
  },

  // The cards (contact, directions, sent ✓, project request): to her left
  // (the visitor's right), vertically centered-ish so they don't cover her
  // face. Unchanged — the boss had no note on them.
  card: {
    right: "2.5%",
    top: "50%",
    translateY: "-55%",
    width: "31%",
    projectWidth: "38%", // the project form has more rows
  },
} as const;
