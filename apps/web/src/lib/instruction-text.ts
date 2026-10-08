// story 4633 (PO web part · Kadir 439): the check the daemon runs on a signed instruction (desktop-host deliver.ts cleanInstructionText).
// A text it would change holds invisible characters. The web asks it before a text goes into the chat as a message, so the same words
// never reach the chat unchecked.
import { cleanInstructionInvisible } from './invisible';

export const INSTRUCTION_TEXT_MAX = 8000;
// every control character except LF, plus U+2028 and U+2029 → a space (the daemon's own order: CRLF/CR → LF first)
const SPACED = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

/** true when the v0.4 instruction filter would change the text — it holds hidden characters, so it is not sent as a message */
export function hiddenCharsChange(text: string): boolean {
  const spaced = text.replace(/\r\n?/g, '\n').replace(SPACED, ' ');
  const cleaned = cleanInstructionInvisible(cleanInstructionInvisible(spaced).slice(0, INSTRUCTION_TEXT_MAX));
  return cleaned !== text;
}
