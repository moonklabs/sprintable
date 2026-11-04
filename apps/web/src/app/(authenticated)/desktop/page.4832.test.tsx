// @vitest-environment jsdom
//
// story 4832 — the two remote-control pages (`/desktop/remote` — the confirm the app opens with `#code=…`; `/desktop/remote-on` — the band's «켜기») are one line of guidance on the
// app's own (local) server: it has no middle server for a phone to relay through, so there is no remote control to turn on. A hosted server draws the page it drew before.
// The pages ask `isEmbeddedServer()` and name no variable; that one helper is stood in for here (story 4825's guard lets only the reading code and the tests that must SET the
// deployment variable name it — and the helper's own test pins the exact value).
import { describe, expect, it, vi } from 'vitest';

const embedded = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/embedded-api-origin', () => ({ isEmbeddedServer: () => embedded.on }));
vi.mock('@/components/desktop/desktop-remote-confirm', () => ({ DesktopRemoteConfirm: () => null }));
vi.mock('@/components/desktop/desktop-remote-on', () => ({ DesktopRemoteOn: () => null }));

type Page = { default: () => { props: { children: { type: unknown } } } };

describe('[SID:4832] /desktop/remote · /desktop/remote-on in local mode', () => {
  it.each([
    ['./remote/page', 'DesktopRemoteConfirm', '@/components/desktop/desktop-remote-confirm'],
    ['./remote-on/page', 'DesktopRemoteOn', '@/components/desktop/desktop-remote-on'],
  ])('%s: the guidance line on the local server, the page\'s own component on any other', async (page, compName, compPath) => {
    const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice');
    const comp = ((await import(compPath)) as Record<string, unknown>)[compName];
    const mod = (await import(page)) as Page;
    embedded.on = true;
    expect(mod.default().props.children.type).toBe(PhoneRelayLocalNotice);
    embedded.on = false;
    expect(mod.default().props.children.type).toBe(comp);
  });
});
