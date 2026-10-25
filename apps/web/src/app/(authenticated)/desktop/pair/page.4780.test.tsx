// story 4780 — the pairing page hands the (checked) page it was entered from to the screen as its [닫기] target
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('@/components/desktop/phone-pairing', () => ({ PhonePairing: () => null }));
const { default: DesktopPairPage } = await import('./page');

async function returnToOf(search: Record<string, string | string[] | undefined>): Promise<unknown> {
  const page = (await DesktopPairPage({ searchParams: Promise.resolve(search) })) as ReactElement<{ children: ReactElement<{ returnTo: unknown }> }>;
  return page.props.children.props.returnTo;
}

describe('[SID:4780] /desktop/pair — the way back handed to the screen', () => {
  it('a page of the app is handed over (checked: the project kept, the rest of the query dropped)', async () => {
    expect(await returnToOf({ from: '/today?p=proj-1&next=//evil.example' })).toBe('/today?p=proj-1'); // reverted (not passed) → undefined
    expect(await returnToOf({ from: '/chats/conv-7' })).toBe('/chats/conv-7');
  });
  it('a value that is not a page of the app is dropped (null → [닫기] goes to /desktop)', async () => {
    expect(await returnToOf({ from: 'https://evil.example/today' })).toBeNull();
    expect(await returnToOf({ from: '//evil.example' })).toBeNull();
    expect(await returnToOf({ from: '/desktop/pair' })).toBeNull();
    expect(await returnToOf({})).toBeNull();
  });
  it('a repeated parameter: the first one counts', async () => {
    expect(await returnToOf({ from: ['/inbox', 'https://evil.example'] })).toBe('/inbox');
  });
});
