// story 4891 (UI-8 · settings › profile · piece ② «알림 도착지 · 차단 목록») — the two list cards and the two small shared parts stand on the ds parts and the SettingsSection frame: none imports an old `@/components/ui/…` part, with ONE named exception:
// the toast HOOK (`@/components/ui/toast` — the context the app's toasts go through; it has no ds twin and is not a visual part). No bare <button>/<input> tags (a bare one is a 28 px press on a phone).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CARDS = ['my-notification-channel-section.tsx', 'blocked-users-section.tsx'];

describe('settings › profile · the two list cards on ds parts', () => {
  for (const f of [...CARDS, 'settings-parts.tsx']) {
    it(`${f}: no old ui/ part (the toast hook is the one named exception) · no bare button/input`, () => {
      const src = readFileSync(join(__dirname, f), 'utf8');
      const olds = [...src.matchAll(/from '@\/components\/ui\/([\w-]+)'/g)].map((m) => m[1]);
      // reverted (a card back on ui/section-card · ui/button · ui/badge · ui/switch …) → this names the file and the part
      expect(olds.filter((p) => p !== 'toast'), `${f} imports old ui/ parts`).toEqual([]);
      expect(src).not.toMatch(/<button[\s>]/);
      expect(src).not.toMatch(/<input[\s/>]/);
    });
  }
  for (const f of CARDS) {
    it(`${f}: the SettingsSection frame`, () => {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).toContain("from './settings-section'");
      expect(src).toContain('<SettingsSection');
      expect(src).not.toContain('<SectionCard');
    });
  }
  it('the profile photo card and its cropper (the part of piece ① left on old parts) are on ds Button and tokens: no ui/ import · no text-micro/text-xs/text-sm · no size="sm" press', () => {
    for (const f of [join('..', 'shared', 'avatar-edit-card.tsx'), join('..', 'shared', 'avatar-cropper.tsx')]) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect([...src.matchAll(/from '@\/components\/ui\/([\w-]+)'/g)].map((m) => m[1]), `${f} imports old ui/ parts`).toEqual([]);
      expect(src, `${f} has a text size under the ds scale`).not.toMatch(/text-(micro|xs|sm)\b/);
      expect(src, `${f} has a 28 px small button`).not.toMatch(/size="sm"/);
    }
  });
  it('no hand-drawn animate-pulse placeholder in the cards of this piece and the notifications tab pieces (ds Skeleton / SkeletonGroup only)', () => {
    for (const f of [...CARDS, 'gate-level-matrix.tsx', join('..', '..', 'app', '(authenticated)', 'settings', 'notifications-pane.tsx')]) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      // reverted to `<div className="… animate-pulse …">` → this names the file
      expect(src, `${f} draws its own pulse placeholder`).not.toContain('animate-pulse');
    }
  });
  it('the destinations card\'s on/off is the 44 px SwitchButton (role=switch on a ds Button), not a 20 px switch', () => {
    const src = readFileSync(join(__dirname, 'my-notification-channel-section.tsx'), 'utf8');
    expect(src).toContain('<SwitchButton');
    const parts = readFileSync(join(__dirname, 'settings-parts.tsx'), 'utf8');
    expect(parts).toContain('role="switch"');
    expect(parts).toContain('touch:h-11 touch:w-14'); // 44 on touch · compact (h-8 w-12) with a mouse
    // the invariants come AFTER the caller's props: an object spread can name a label, never swap the role / state / handler
    expect(parts.indexOf('{...aria}')).toBeLessThan(parts.indexOf('role="switch"'));
    expect(parts.indexOf('{...aria}')).toBeLessThan(parts.indexOf('aria-checked={checked}'));
  });
});
