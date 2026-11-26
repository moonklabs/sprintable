// story 4829 (공개 2-⑥ (나)) — `/desktop/pair` in the app's own server (local mode): there is no middle server for a phone to pair through, so the page is one line of guidance,
// not the pairing (and the pairing screen, which reads the phone's list, is not even built). Hosted mode: the pairing screen as before (AC2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('@/components/desktop/phone-pairing', () => ({ PhonePairing: () => null }));

const saved = process.env.SPRINTABLE_EMBEDDED; const savedPublic = process.env.SPRINTABLE_PUBLIC_ORIGIN;
afterEach(() => {
  if (saved === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = saved;
  if (savedPublic === undefined) delete process.env.SPRINTABLE_PUBLIC_ORIGIN; else process.env.SPRINTABLE_PUBLIC_ORIGIN = savedPublic;
  vi.resetModules();
});

async function bodyTypeWith(embedded: string | undefined, publicOrigin?: string): Promise<unknown> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
  if (publicOrigin === undefined) delete process.env.SPRINTABLE_PUBLIC_ORIGIN; else process.env.SPRINTABLE_PUBLIC_ORIGIN = publicOrigin;
  vi.resetModules();
  const { default: DesktopPairPage } = await import('./page');
  const page = (await DesktopPairPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ children: ReactElement }>;
  return page.props.children.type;
}

describe('[SID:4829] /desktop/pair — local mode', () => {
  it('local mode: the guidance, not the pairing screen', async () => {
    const type = await bodyTypeWith('1');
    const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice'); // after the call: the same module registry as the page's
    expect(type).toBe(PhoneRelayLocalNotice);
  });
  // story 5025 (found on the VM round: a server host's phone could not open the pairing screen — /desktop/remote and /desktop/remote-on already let a server host through, this page did not)
  it('a workspace SERVER HOST (embedded + a valid public address) is the middle server a phone pairs through: the pairing screen, not the local-mode guidance', async () => {
    const type = await bodyTypeWith('1', 'https://team.example.com');
    const { PhonePairing } = await import('@/components/desktop/phone-pairing');
    expect(type).toBe(PhonePairing);
  });
  it('embedded with NO public address, or one that is not a valid address, is still the app\'s own loopback server: the guidance', async () => {
    for (const origin of [undefined, '', 'http://team.example.com', 'https://localhost', 'https://team.example.com/path', 'team.example.com']) {
      const type = await bodyTypeWith('1', origin);
      const { PhoneRelayLocalNotice } = await import('@/components/desktop/phone-relay-local-notice'); // after the call: the same module registry as the page's
      expect(type, `SPRINTABLE_PUBLIC_ORIGIN=${String(origin)}`).toBe(PhoneRelayLocalNotice);
    }
  });
  it('hosted mode (AC2): the pairing screen, as before', async () => {
    for (const value of [undefined, '', '0', 'true']) {
      const type = await bodyTypeWith(value);
      const { PhonePairing } = await import('@/components/desktop/phone-pairing');
      expect(type, `SPRINTABLE_EMBEDDED=${String(value)}`).toBe(PhonePairing);
    }
  });
});
