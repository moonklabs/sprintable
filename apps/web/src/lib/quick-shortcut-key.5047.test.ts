import { describe, expect, it } from 'vitest';
import { acceleratorFromKeyPress, acceleratorKeyOf } from './quick-shortcut-key';

const press = (code: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

describe('[SID:5047] the key a person presses → the shortcut text the app takes', () => {
  it('Option+Space → «Alt+Space» (the app\'s own default)', () => {
    expect(acceleratorFromKeyPress(press('Space', { altKey: true }))).toBe('Alt+Space');
  });

  it('modifiers come first in one fixed order whatever order they were pressed, then the key', () => {
    expect(acceleratorFromKeyPress(press('KeyK', { shiftKey: true, metaKey: true }))).toBe('Command+Shift+K');
    expect(acceleratorFromKeyPress(press('Digit1', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+1');
    expect(acceleratorFromKeyPress(press('F12', { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }))).toBe('Command+Control+Alt+Shift+F12');
  });

  it('the key is read by its PHYSICAL name: Option+K on a Mac types «˚», the shortcut is still K (reverted → the typed character is used and the app refuses it)', () => {
    expect(acceleratorFromKeyPress({ ...press('KeyK', { altKey: true }), key: '˚' } as never)).toBe('Alt+K');
  });

  it.each([['KeyA', 'A'], ['KeyZ', 'Z'], ['Digit0', '0'], ['Digit9', '9'], ['F1', 'F1'], ['F24', 'F24'], ['Space', 'Space'], ['Enter', 'Return'], ['ArrowUp', 'Up'], ['PageDown', 'PageDown'], ['Slash', '/'], ['Backquote', '`'], ['Backslash', '\\'], ['Quote', "'"]])('%s → %s', (code, key) => {
    expect(acceleratorKeyOf(code)).toBe(key);
  });

  it.each(['AltLeft', 'AltRight', 'ControlLeft', 'MetaRight', 'ShiftLeft', 'CapsLock'])('%s alone is not a shortcut yet: null (the person is still reaching for the key)', (code) => {
    expect(acceleratorFromKeyPress(press(code, { altKey: true }))).toBeNull();
  });

  it.each(['Escape', 'F25', 'KeyAA', 'Numpad1', 'MediaPlayPause', '', 'Unidentified'])('a key the app does not take (%j) → null (the person presses again)', (code) => {
    expect(acceleratorFromKeyPress(press(code, { altKey: true }))).toBeNull();
  });

  it('no modifier at all still builds the text — the APP judges whether a shortcut is usable (its one rule stays in one place)', () => {
    expect(acceleratorFromKeyPress(press('KeyK'))).toBe('K');
  });
});

describe('[SID:5047] isModifierCode (the row keeps listening while only a modifier is down)', () => {
  it('names the modifier keys themselves and nothing else', async () => {
    const { isModifierCode } = await import('./quick-shortcut-key');
    for (const c of ['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'Fn']) expect(isModifierCode(c), c).toBe(true);
    for (const c of ['KeyK', 'Space', 'Digit1', 'F5', 'Numpad1', 'Escape', '']) expect(isModifierCode(c), c).toBe(false);
  });
});
