// story 5047 (C14 · PO 11-27): the key combination the person presses while changing the quick-ask shortcut → the shortcut text the app takes («Alt+Space» · «Command+Shift+K»).
// Built from the key's PHYSICAL name (`code`), not its letter: with Option held a Mac key types another character (⌥K → «˚»), and the app's register call wants the key, not the character. Pure.

const NAMED: Readonly<Record<string, string>> = Object.freeze({
  Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
});

/** the modifier keys themselves: pressing one alone is not a shortcut yet — the person is still reaching for the key (the row keeps listening) */
export function isModifierCode(code: string): boolean {
  return /^(Alt|Control|Meta|Shift)(Left|Right)$/.test(code) || code === 'CapsLock' || code === 'Fn' || code === 'OS' || code === 'OSLeft' || code === 'OSRight';
}

export interface KeyPress { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** the key's name in the app's accelerator words, or null when the code is not a key the app takes */
export function acceleratorKeyOf(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return `F${fn[1]}`;
  return NAMED[code] ?? null;
}

/** `null` while only modifiers are down (wait for the key) or when the key is not one the app takes (the person presses again); otherwise the text — modifiers first, then the key. The app judges whether it is a usable shortcut
 *  (it needs a modifier other than Shift): this function never decides that, so the app's one rule stays in one place. */
export function acceleratorFromKeyPress(e: KeyPress): string | null {
  const key = acceleratorKeyOf(e.code);
  if (key === null) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}
