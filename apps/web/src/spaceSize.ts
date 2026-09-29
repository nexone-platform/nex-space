// How big the team is, and therefore how many desks their office has to have.
//
// The wizard asked this on the second screen and then did nothing with the
// answer. Every layout on offer seated ten people or fewer, so a company that
// said "51+" was handed an office with six desks in it and no indication that
// anything was wrong — the question looked like it mattered and did not.
//
// The brackets live here rather than in the wizard because three separate
// things need them now: the question itself, the layout picker that has to know
// what "enough" means, and the check that refuses a release where some bracket
// has no office big enough for it.

export interface Bracket {
  /**
   * What the wizard shows AND what is stored on the account.
   *
   * The two are the same string on purpose. Accounts already carry these exact
   * labels from before this file existed, and an id beside a label would mean
   * migrating them for no gain.
   */
  label: string;
  /** desks an office must have to be offered for this bracket without a warning */
  seats: number;
}

export const SIZES: Bracket[] = [
  { label: "1 - 10", seats: 10 },
  { label: "11 - 50", seats: 50 },
  // Open-ended, so the number is a judgement rather than a reading: 80 desks is
  // a floor plate a company of this size can actually move into, and anyone
  // past it can add more in the map editor. Better an honest number than a
  // bracket nothing can ever satisfy.
  { label: "51+", seats: 80 },
];

/**
 * How many desks this answer needs.
 *
 * An answer nobody recognises — an older account, a hand-edited profile — asks
 * for nothing rather than for the largest office. Guessing upward would push
 * a two-person team into a floor built for eighty.
 */
export function seatsFor(companySize: string | null | undefined): number {
  return SIZES.find((s) => s.label === companySize)?.seats ?? 0;
}
