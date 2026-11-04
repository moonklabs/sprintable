// @vitest-environment jsdom
//
// story 4832 — the two remote-control pages (`/desktop/remote` — the confirm the app opens with `#code=…`; `/desktop/remote-on` — the band's «켜기») are one line of guidance on the
// app's own (local) server: it has no middle server for a phone to relay through, so there is no remote control to turn on. A hosted server draws the page it drew before.
// The marker is read per request, so each case sets it and loads the page fresh (as page.4829.test.tsx does for `/desktop`).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/desktop/desktop-remote-confirm', () => ({ DesktopRemoteConfirm: () => null }));
vi.mock('@/components/desktop/desktop-remote-on', () => ({ DesktopRemoteOn: () => null }));

const saved = process.env.SPRINTABLE_EMBEDDED;
afterEach(() => {
  if (saved === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = saved;
  vi.resetModules();
});

type Page = { default: () => { props: { children: { type: unknown } } } };
// the page and the guidance component are imported AFTER the module reset, from the same registry — a component imported before the reset is another function
async function showsGuidance(path: string, embedded: string | undefined): Promise<boolean> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  vi.resetModules();
  const mod = (await import(path)) as Page;
  const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice');
  return mod.default().props.children.type === PhoneRelayLocalNotice;
}

describe('[SID:4832] /desktop/remote · /desktop/remote-on in local mode', () => {
  it.each([
    ['./remote/page'],
    ['./remote-on/page'],
  ])('%s: the guidance line in local mode, the page itself for every other value (only the exact «1» is local)', async (page) => {
    expect(await showsGuidance(page, '1')).toBe(true);
    for (const value of [undefined, '', '0', 'true']) expect(await showsGuidance(page, value), `marker ${String(value)}`).toBe(false);
  });
});
