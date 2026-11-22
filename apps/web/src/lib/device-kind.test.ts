// story 4994 (P4-d · D-3): which device the shell's web view runs on, and the computer's name for the host's list. Each test goes red without the line it names.
import { describe, expect, it } from 'vitest';
import { computerLabel, deviceKindOf } from './device-kind';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) sprintable-desktop/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36';
const LIN = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Sprintable/0.2.264 Chrome/140.0.0.0 Electron/44.4.5 Safari/537.36';

describe('[SID:4994] device kind', () => {
  it('the guest desktop app (a UA that says `Electron/`) is a computer; every phone app\'s WebView — and anything unknown — is a phone', () => {
    for (const ua of [MAC, WIN, LIN]) expect(deviceKindOf(ua), ua).toBe('computer');
    for (const ua of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
      'Mozilla/5.0 (Linux; Android 15; SM-S938N Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      '',
    ]) expect(deviceKindOf(ua), ua).toBe('phone');
    expect(deviceKindOf(undefined)).toBe('phone');
    expect(deviceKindOf('NotElectron/1')).toBe('phone'); // (the word, not a part of another)
  });
  it('a computer is named for its OS — Mac · Windows PC · Linux PC (the host\'s list shows it; it was «Android»)', () => {
    expect(computerLabel(MAC)).toBe('Mac'); expect(computerLabel(WIN)).toBe('Windows PC'); expect(computerLabel(LIN)).toBe('Linux PC');
  });
});
