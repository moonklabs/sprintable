// story 4794 — the first letter(s) of a NAME for an avatar. `name.slice(0, 1)` / `charAt(0)` / `name[0]` cut a UTF-16 code unit: a name that starts with an
// emoji («👩‍💻 두리» — the «에이전트 만들기» card takes such names) gave a lone half of a surrogate pair, drawn as «�». A grapheme is what a person
// sees as one letter (an emoji with its joiners, a letter with its accent); the browser's Intl.Segmenter knows them, and where it is missing the code points
// are the next best thing (still never half of a pair).
const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

const piecesOf = (text: string): string[] => (segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text));

/** The first `count` graphemes of `text` (all of it when shorter; '' for a count below 1). */
export function firstGraphemes(text: string, count: number): string {
  if (count < 1 || !text) return '';
  return piecesOf(text).slice(0, count).join('');
}

/** The longest start of `text` made of whole graphemes that is at most `maxCodePoints` code points long — for a name or a label that goes to the server,
 *  which counts code points (a Python str): a cut by UTF-16 units can leave half of a surrogate pair (the server then sees a broken character), and a cut by
 *  graphemes can run past the server's count (one ZWJ emoji is up to ten code points). A grapheme that does not fit whole is left out. */
export function graphemesWithin(text: string, maxCodePoints: number): string {
  if (maxCodePoints < 1 || !text) return '';
  let used = 0;
  let out = '';
  for (const piece of piecesOf(text)) {
    const n = Array.from(piece).length;
    if (used + n > maxCodePoints) break;
    used += n;
    out += piece;
  }
  return out;
}
