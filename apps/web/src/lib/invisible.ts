// story 4633 (PO web part · Kadir 439): a copy of desktop-protocol/invisible.ts in the mobile repo — the one table of invisible characters.
// Change the table there first, then copy it here (the web cannot import the mobile repo). The body below is byte-identical to that file.
// story #4592 (Kadir PR 377 codex #3 · 437 codex): the one table of what a name shown to a person loses — an agent's · a device's ·
// a conversation's name on the phone's fingerprint sheet, the desktop app's screens and the host's board. 4633 (signed instruction
// text) uses the same table under its own contract.
//
// The phone (lib/invisible.js) and the Electron shell (desktop-electron/src/invisible.ts) cannot import this file (the phone is
// plain JS under Expo; the shell's vitest transforms a cross-package import with the repo root's Expo tsconfig, absent in CI), so
// each keeps a byte-identical copy of the class strings. desktop-host/test/invisible-table.test.ts fails when a copy differs, when
// a Unicode format or default-ignorable character is in no class, and when a base set differs from what Unicode says it is.
// The base sets are written out as ranges (generated from Unicode 17, checked by that test) rather than `\p{…}`: the phone's
// JavaScript engine is not relied on for Unicode property escapes.

/** Control characters — C0 · DEL · C1 · the line and paragraph separators. Each caller says what they become (a space, or nothing). */
export const CONTROL_CLASS = '\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029';

/**
 * Invisible characters, removed outright (a name keeps its words joined): Unicode Cf (format) and Default_Ignorable_Code_Point,
 * minus the ones that draw (CF_KEPT), the variation selectors (VS_CLASS — kept by position) and the blank look-alikes
 * (NAME_BLANK_CLASS). Soft hyphen · combining grapheme joiner · Arabic letter mark (U+061C) · the Hangul choseong/jungseong fillers ·
 * the Khmer inherent vowels · Mongolian vowel separator · zero-width space / non-joiner / joiner and the direction marks · the bidi
 * embeddings, overrides and isolates · word joiner, invisible operators and the deprecated format controls · the byte order mark ·
 * the reserved specials and interlinear annotation marks · the shorthand format controls · the musical beam and phrase controls ·
 * the language tag, the tag characters (an invisible copy of ASCII) and the unassigned default-ignorable planes around them.
 */
export const FORMAT_CLASS =
  '\\u00ad\\u034f\\u061c\\u115f-\\u1160\\u17b4-\\u17b5\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff\\ufff0-\\ufffb' +
  '\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e00ff}\\u{e01f0}-\\u{e0fff}';

/**
 * Kadir 437 codex: characters that draw as an empty cell — the usual way to fake a blank name (Braille pattern blank · the Hangul
 * filler · its halfwidth form). In a name each becomes a space, so it folds and trims away; a name of nothing else is empty.
 */
export const NAME_BLANK_CLASS = '\\u2800\\u3164\\uffa0';

/**
 * Variation selectors (default-ignorable, yet they choose the glyph): a run of them after one visible character carries bytes a
 * person never sees («emoji smuggling» — Kadir 437). Kept by position only (cleanVariationSelectors): one, right after a base that
 * takes it; FE00–FE0D never.
 */
export const VS_CLASS = '\\ufe00-\\ufe0f\\u180b-\\u180d\\u180f\\u{e0100}-\\u{e01ef}';

/** Extended_Pictographic (Unicode 17), the base of U+FE0E/FE0F — plus the keycap bases 0-9 # * */
export const PICTOGRAPHIC_CLASS =
  '\\u00a9\\u00ae\\u203c\\u2049\\u2122\\u2139\\u2194-\\u2199\\u21a9-\\u21aa\\u231a-\\u231b\\u2328\\u23cf\\u23e9-\\u23f3\\u23f8-\\u23fa\\u24c2' +
  '\\u25aa-\\u25ab\\u25b6\\u25c0\\u25fb-\\u25fe\\u2600-\\u2604\\u260e\\u2611\\u2614-\\u2615\\u2618\\u261d\\u2620\\u2622-\\u2623\\u2626' +
  '\\u262a\\u262e-\\u262f\\u2638-\\u263a\\u2640\\u2642\\u2648-\\u2653\\u265f-\\u2660\\u2663\\u2665-\\u2666\\u2668\\u267b\\u267e-\\u267f' +
  '\\u2692-\\u2697\\u2699\\u269b-\\u269c\\u26a0-\\u26a1\\u26a7\\u26aa-\\u26ab\\u26b0-\\u26b1\\u26bd-\\u26be\\u26c4-\\u26c5\\u26c8\\u26ce-\\u26cf' +
  '\\u26d1\\u26d3-\\u26d4\\u26e9-\\u26ea\\u26f0-\\u26f5\\u26f7-\\u26fa\\u26fd\\u2702\\u2705\\u2708-\\u270d\\u270f\\u2712\\u2714\\u2716\\u271d' +
  '\\u2721\\u2728\\u2733-\\u2734\\u2744\\u2747\\u274c\\u274e\\u2753-\\u2755\\u2757\\u2763-\\u2764\\u2795-\\u2797\\u27a1\\u27b0\\u27bf' +
  '\\u2934-\\u2935\\u2b05-\\u2b07\\u2b1b-\\u2b1c\\u2b50\\u2b55\\u3030\\u303d\\u3297\\u3299\\u{1f004}\\u{1f02c}-\\u{1f02f}\\u{1f094}-\\u{1f09f}' +
  '\\u{1f0af}-\\u{1f0b0}\\u{1f0c0}\\u{1f0cf}-\\u{1f0d0}\\u{1f0f6}-\\u{1f0ff}\\u{1f170}-\\u{1f171}\\u{1f17e}-\\u{1f17f}\\u{1f18e}' +
  '\\u{1f191}-\\u{1f19a}\\u{1f1ae}-\\u{1f1e5}\\u{1f201}-\\u{1f20f}\\u{1f21a}\\u{1f22f}\\u{1f232}-\\u{1f23a}\\u{1f23c}-\\u{1f23f}' +
  '\\u{1f249}-\\u{1f25f}\\u{1f266}-\\u{1f321}\\u{1f324}-\\u{1f393}\\u{1f396}-\\u{1f397}\\u{1f399}-\\u{1f39b}\\u{1f39e}-\\u{1f3f0}' +
  '\\u{1f3f3}-\\u{1f3f5}\\u{1f3f7}-\\u{1f3fa}\\u{1f400}-\\u{1f4fd}\\u{1f4ff}-\\u{1f53d}\\u{1f549}-\\u{1f54e}\\u{1f550}-\\u{1f567}' +
  '\\u{1f56f}-\\u{1f570}\\u{1f573}-\\u{1f57a}\\u{1f587}\\u{1f58a}-\\u{1f58d}\\u{1f590}\\u{1f595}-\\u{1f596}\\u{1f5a4}-\\u{1f5a5}\\u{1f5a8}' +
  '\\u{1f5b1}-\\u{1f5b2}\\u{1f5bc}\\u{1f5c2}-\\u{1f5c4}\\u{1f5d1}-\\u{1f5d3}\\u{1f5dc}-\\u{1f5de}\\u{1f5e1}\\u{1f5e3}\\u{1f5e8}\\u{1f5ef}' +
  '\\u{1f5f3}\\u{1f5fa}-\\u{1f64f}\\u{1f680}-\\u{1f6c5}\\u{1f6cb}-\\u{1f6d2}\\u{1f6d5}-\\u{1f6e5}\\u{1f6e9}\\u{1f6eb}-\\u{1f6f0}' +
  '\\u{1f6f3}-\\u{1f6ff}\\u{1f7da}-\\u{1f7ff}\\u{1f80c}-\\u{1f80f}\\u{1f848}-\\u{1f84f}\\u{1f85a}-\\u{1f85f}\\u{1f888}-\\u{1f88f}' +
  '\\u{1f8ae}-\\u{1f8af}\\u{1f8bc}-\\u{1f8bf}\\u{1f8c2}-\\u{1f8cf}\\u{1f8d9}-\\u{1f8ff}\\u{1f90c}-\\u{1f93a}\\u{1f93c}-\\u{1f945}' +
  '\\u{1f947}-\\u{1f9ff}\\u{1fa58}-\\u{1fa5f}\\u{1fa6e}-\\u{1faff}\\u{1fc00}-\\u{1fffd}';
/** Script=Han (Unicode 17), the base of the ideographic variation selectors U+E0100–E01EF */
export const HAN_CLASS =
  '\\u2e80-\\u2e99\\u2e9b-\\u2ef3\\u2f00-\\u2fd5\\u3005\\u3007\\u3021-\\u3029\\u3038-\\u303b\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufa6d' +
  '\\ufa70-\\ufad9\\u{16fe2}-\\u{16fe3}\\u{16ff0}-\\u{16ff6}\\u{20000}-\\u{2a6df}\\u{2a700}-\\u{2b81d}\\u{2b820}-\\u{2cead}\\u{2ceb0}-\\u{2ebe0}' +
  '\\u{2ebf0}-\\u{2ee5d}\\u{2f800}-\\u{2fa1d}\\u{30000}-\\u{3134a}\\u{31350}-\\u{33479}';
/** Script=Mongolian (Unicode 17), the base of the Mongolian free variation selectors */
export const MONGOLIAN_CLASS = '\\u1800-\\u1801\\u1804\\u1806-\\u1819\\u1820-\\u1878\\u1880-\\u18aa\\u{11660}-\\u{1166c}';

/**
 * The Cf code points kept, each because it draws: removing it would change text a person sees (AC3: visible text stays as it was).
 * [first, last, why] — inclusive.
 */
export const CF_KEPT: ReadonlyArray<readonly [number, number, string]> = [
  [0x0600, 0x0605, 'Arabic number sign · sanah · footnote marker · safha · samvat · number mark above — drawn spanning the digits after them'],
  [0x06dd, 0x06dd, 'Arabic end of ayah — drawn around the verse number'],
  [0x070f, 0x070f, 'Syriac abbreviation mark — drawn over the letters after it'],
  [0x0890, 0x0891, 'Arabic pound and piastre marks above — drawn over the digits'],
  [0x08e2, 0x08e2, 'Arabic disputed end of ayah — drawn around the number'],
  [0x110bd, 0x110bd, 'Kaithi number sign — drawn over the digits'],
  [0x110cd, 0x110cd, 'Kaithi number sign above — drawn over the digits'],
  [0x13430, 0x1343f, 'Egyptian hieroglyph format controls — they place the signs drawn next to them; removing one moves visible signs'],
];

/** Every control character, global (and Unicode, so a `\u{…}` range is a code point). */
export const CONTROLS = new RegExp(`[${CONTROL_CLASS}]`, 'gu');
/** Every invisible format character above, global. */
export const FORMAT = new RegExp(`[${FORMAT_CLASS}]`, 'gu');
/** Every blank look-alike, global — a name turns each into a space. */
export const NAME_BLANK = new RegExp(`[${NAME_BLANK_CLASS}]`, 'gu');

const SELECTOR = new RegExp(`^[${VS_CLASS}]$`, 'u');
const EMOJI_BASE = new RegExp(`^[${PICTOGRAPHIC_CLASS}0-9#*]$`, 'u');
const HAN_BASE = new RegExp(`^[${HAN_CLASS}]$`, 'u');
const MONGOLIAN_BASE = new RegExp(`^[${MONGOLIAN_CLASS}]$`, 'u');

/**
 * Kadir 437: a variation selector stays only right after a base that takes it — U+FE0E/FE0F after an Extended_Pictographic or a
 * keycap base, U+E0100–E01EF after a Han character, U+180B–180D/180F after a Mongolian letter — one per base (a second in a row
 * goes), never at the start or after a space or another kind of character; U+FE00–FE0D always go. What draws stays as it drew.
 */
export function cleanVariationSelectors(s: string): string {
  let out = '';
  let base = ''; // the character just kept, while a selector may still follow it
  for (const ch of s) {
    if (!SELECTOR.test(ch)) { out += ch; base = ch; continue; }
    const cp = ch.codePointAt(0)!;
    const fits = base !== '' && ((cp === 0xfe0e || cp === 0xfe0f) ? EMOJI_BASE.test(base)
      : cp >= 0xe0100 ? HAN_BASE.test(base)
      : cp >= 0x180b && cp <= 0x180f ? MONGOLIAN_BASE.test(base)
      : false);
    if (fits) out += ch;
    base = ''; // one selector per base
  }
  return out;
}

/**
 * story 4633 (signed instruction text, contract v0.4 §2): U+200C and U+200D are the zero-width non-joiner and joiner. They shape
 * Persian and Indic words and join emoji sequences, so they stay — but only where they belong, one at a time (the usual zero-width
 * binary encoding lives in runs of them and next to spaces). A joiner stays only between two pictographic characters (U+200D) or
 * two letters of a script that uses it (U+200C); anything else goes. Names keep removing both (FORMAT, unchanged).
 */
export const ZWNJ = '\u200c';
export const ZWJ = '\u200d';
/** The skin-tone modifiers (Unicode 17) join the pictographic bases a joiner may sit between. */
const SKIN_TONE_CLASS = '\\u{1f3fb}-\\u{1f3ff}';
/** Arabic script and the Indic scripts (Devanagari … Sinhala) — the letters a zero-width non-joiner may sit between. Written as blocks. */
export const JOINER_SCRIPT_CLASS = '\\u0600-\\u06ff\\u0750-\\u077f\\u08a0-\\u08ff\\ufb50-\\ufdff\\ufe70-\\ufeff\\u0900-\\u0dff';
const JOINER_PICT = new RegExp(`^[${PICTOGRAPHIC_CLASS}${SKIN_TONE_CLASS}]$`, 'u');
const JOINER_SCRIPT = new RegExp(`^[${JOINER_SCRIPT_CLASS}]$`, 'u');

/**
 * Removes every FORMAT character except the two joiners (those are judged by cleanJoiners). Names do not use this: they remove
 * FORMAT whole.
 */
export function dropFormat(s: string): string {
  return s.replace(FORMAT, (c) => (c === ZWNJ || c === ZWJ ? c : ''));
}

/**
 * story 4633 §2: a zero-width joiner or non-joiner stays only between its neighbours, looked at in the text as it stands after the
 * other steps. Variation selectors between a pictographic base and the joiner are skipped (the heart-family emoji 2764 FE0F 200D
 * 1F468 keeps its joiner). Both neighbours must fit, so a run of two, a space, a line end or a Latin letter removes it.
 */
export function cleanJoiners(s: string): string {
  const cs = [...s];
  let out = '';
  cs.forEach((ch, i) => {
    if (ch !== ZWNJ && ch !== ZWJ) { out += ch; return; }
    let j = i - 1;
    while (j >= 0 && SELECTOR.test(cs[j])) j--;
    const before = j >= 0 ? cs[j] : '';
    const after = i + 1 < cs.length ? cs[i + 1] : '';
    const fits = ch === ZWJ ? JOINER_PICT.test(before) && JOINER_PICT.test(after) : JOINER_SCRIPT.test(before) && JOINER_SCRIPT.test(after);
    if (fits) out += ch;
  });
  return out;
}

/** The final pass's rule (story 4633 §4, Kadir 439 review): FORMAT removed, selectors by position, joiners by position. */
export function cleanFormat(s: string): string {
  return cleanJoiners(cleanVariationSelectors(dropFormat(s)));
}

/**
 * story 4633 §2 (the instruction filter's invisible part, after CRLF/CR → LF and the controls → a space): FORMAT removed (joiners by
 * position), variation selectors by position, blank look-alikes removed — except U+2800, which is real braille and draws.
 */
export function cleanInstructionInvisible(s: string): string {
  return cleanJoiners(cleanVariationSelectors(dropFormat(s))).replace(NAME_BLANK, (c) => (c === '\u2800' ? c : ''));
}
