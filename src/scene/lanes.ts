/**
 * Lateral geometry of the four string lanes.
 *
 * The instrument is strung as standard — on a violin G, D, A, E from left
 * to right — and indexed 0..3 in that order, matching STRINGS in ../state.
 * Classical naming counts the other way, from the highest string down:
 * I = E, II = A, III = D, IV = G ("the fourth string" is the G on a violin,
 * the C on a viola). STRINGS carries each string's numeral so a future
 * viola/cello set can keep the same lane indexing.
 *
 * As on the reference photograph the strings fan out from the nut to the
 * bridge (they fan in again toward the tailpiece, but that is below the
 * view). The spacings match a real setup — ≈5.5 mm between strings at the
 * nut and ≈11.3 mm at the bridge on a 328 mm speaking length — at this
 * scene's scale of 1 world unit ≈ 88 mm.
 */
export const N_LANES = 4;
const NUT_GAP = 0.062;
const BRIDGE_GAP = 0.128;

/** Lateral world-x of lane `idx` (0 = IV/lowest, leftmost) at position `s`
 * along the string (0 = nut, 1 = bridge). */
export function laneX(idx: number, s: number): number {
  return (idx - (N_LANES - 1) / 2) * (NUT_GAP + (BRIDGE_GAP - NUT_GAP) * s);
}

/** Rendered line width (px) per lane: the wound G is visibly the heaviest
 * string, the plain E the finest. */
export const LANE_LINEWIDTH = [3.1, 2.8, 2.55, 2.2];
