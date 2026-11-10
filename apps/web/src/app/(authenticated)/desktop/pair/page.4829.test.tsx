// story 4829 (공개 2-⑥ (나)) — `/desktop/pair` in the app's own server (local mode): there is no middle server for a phone to pair through, so the page is one line of guidance,
// not the pairing (and the pairing screen, which reads the phone's list, is not even built). Hosted mode: the pairing screen as before (AC2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('@/components/desktop/phone-pairing', () => ({ PhonePairing: () => null }));

const saved = process.env.SPRINTABLE_EMBEDDED;
afterEach(() => { if (saved === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = saved; vi.resetModules(); });

async function bodyTypeWith(embedded: string | undefined): Promise<unknown> {
  if (embedded === undefined) delete process.env.SPRINTABLE_EMBEDDED; else process.env.SPRINTABLE_EMBEDDED = embedded;
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
  it('hosted mode (AC2): the pairing screen, as before', async () => {
    for (const value of [undefined, '', '0', 'true']) {
      const type = await bodyTypeWith(value);
      const { PhonePairing } = await import('@/components/desktop/phone-pairing');
      expect(type, `SPRINTABLE_EMBEDDED=${String(value)}`).toBe(PhonePairing);
    }
  });
});
