/**
 * The key a press gets in the states spec's `small` list (a press whose REACHED size is under 44 px at 390).
 * Only the side that is under 44 goes into the key — `h20` (a link 20 high), `w24` (a checkbox 24 wide), `24x20` (both). The side that is 44 or more is NOT written:
 * a text link's WIDTH is the width of its letters, which a Mac and a Linux runner draw 1-2 px apart (codex 6062 CI: `리뷰 에이전트 106x20` on the Mac · `108x20` on Linux), while a HEIGHT / a fixed width comes from the CSS and is the same everywhere.
 * (The spec sends this function's source into the page, so it must stay a plain function with no imports.)
 */
export function pressKey(label: string, w: number, h: number): string {
  const lowW = w < 43.5;
  const lowH = h < 43.5;
  const W = Math.round(w);
  const H = Math.round(h);
  return lowW && lowH ? `${label} ${W}x${H}` : lowH ? `${label} h${H}` : `${label} w${W}`;
}
