// @vitest-environment jsdom
//
// story 4952 (S1b) — the live measurement on dev build 89 found it: the goal delete confirmation is a Base UI dialog (role=dialog, NO aria-modal), so the support launcher stayed drawn above its scrim.
// Every Base UI modal popup of the app carries the marker `data-modal-popup` (guard: shared/modal-popup-marker.guard.test.ts) and `data-open` while open. Real mount of the app's own Dialog and Sheet
// + the launcher's real selector.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAUNCHER = readFileSync(join(__dirname, 'support-widget-launcher.tsx'), 'utf8');
const BUTTON = LAUNCHER.slice(LAUNCHER.indexOf('<button'), LAUNCHER.indexOf('</button>'));
const selectorOf = (cls: string) => cls.slice(cls.indexOf('[:root') + 1, cls.indexOf('_&]'));
const SELECTOR = selectorOf(BUTTON.match(/\[:root:has\([^\s]*?\)_&\]:invisible/)?.[0] ?? '');
const hides = () => document.documentElement.matches(SELECTOR);

let container: HTMLDivElement | undefined;
let root: Root | undefined;
const mount = async (node: React.ReactNode) => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const r = createRoot(el);
  container = el; root = r;
  await act(async () => {
    r.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);
  });
};
afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  container?.remove();
  root = undefined; container = undefined;
});

describe('the support launcher hides under an open Base UI modal (4952 S1b)', () => {
  it('the selector was read from the launcher source', () => {
    expect(SELECTOR).toContain('data-modal-popup');
  });

  it('⭐an open ui/dialog hides it (the goal delete confirmation is this component)', async () => {
    await mount(<Dialog open><DialogContent><DialogTitle>목표를 삭제할까요?</DialogTitle></DialogContent></Dialog>);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBeNull(); // the premise: no aria-modal, so the old rule could not see it
    expect(hides()).toBe(true);
  });

  it('⭐an open ui/sheet hides it', async () => {
    await mount(<Sheet open><SheetContent><SheetTitle>시트</SheetTitle></SheetContent></Sheet>);
    expect(hides()).toBe(true);
  });

  it('a closed ui/dialog leaves it alone', async () => {
    await mount(<Dialog open={false}><DialogContent><DialogTitle>닫힘</DialogTitle></DialogContent></Dialog>);
    expect(hides()).toBe(false);
  });
});
