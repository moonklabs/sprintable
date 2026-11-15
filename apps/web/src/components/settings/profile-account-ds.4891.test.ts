// story 4891 (UI-8 · settings › profile · piece ① «내 계정») — the five account cards (my profile · set a password · linked accounts · two-factor · other devices) stand on the ds parts and the shared SettingsSection frame:
// none of their files imports an old `@/components/ui/…` part. (Pinned as a read of the files' imports — the same way as the notifications tab's.) Their behaviour is pinned by each card's own test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = ['my-profile-section.tsx', 'set-password-section.tsx', 'linked-accounts-section.tsx', 'two-factor-section.tsx', 'other-sessions-section.tsx'];

describe('settings › profile · «내 계정» cards on ds parts', () => {
  for (const f of FILES) {
    it(`${f}: no old ui/ import · the SettingsSection frame`, () => {
      const src = readFileSync(join(__dirname, f), 'utf8');
      // reverted (a card back on ui/section-card · ui/button · ui/dialog …) → this names the file
      expect(src).not.toMatch(/from '@\/components\/ui\//);
      expect(src).toContain("from './settings-section'");
      expect(src).toContain('<SettingsSection');
      expect(src).not.toContain('<SectionCard');
      // the controls are the ds parts, not bare tags (a bare <button>/<input> is a 28 px press on a phone)
      expect(src).not.toMatch(/<button[\s>]/);
      expect(src).not.toMatch(/<input[\s/>]/);
    });
  }
});

describe('linked accounts: the provider rows are separated', () => {
  it('the list draws the separators itself (divide-y) and no row draws its own bottom border away — each row is the only child of its <li>, so a `last:` rule would remove every separator', () => {
    const src = readFileSync(join(__dirname, 'linked-accounts-section.tsx'), 'utf8');
    expect(src).toContain('divide-y divide-ds-line');
    expect(src).not.toContain('last:border-b-0');
    expect(src).toContain('className="border-b-0"');
  });
});
