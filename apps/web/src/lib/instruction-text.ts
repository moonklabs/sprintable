// story 4633 (PO web part · Kadir 439): the invisible-character check of the daemon's signed-instruction filter (desktop-host deliver.ts
// cleanInstructionText). A text it would change holds invisible format characters (tags, bidi marks, zero-width characters, a selector
// run, a blank look-alike). Only those count here: a tab, a CR or another control character is shown as it is in the chat, so it is not
// hidden (Kadir 943fac90f: counting it refused plain typed text). The web asks this before a text goes into the chat as a message.
import { cleanInstructionInvisible } from './invisible';

/** true when the invisible characters would be removed from the text — it is not sent as a message */
export function hiddenCharsChange(text: string): boolean {
  return cleanInstructionInvisible(text) !== text;
}
