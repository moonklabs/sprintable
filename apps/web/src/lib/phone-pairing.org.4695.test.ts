// [SID:4695] the phone's pairing page sits outside the dashboard shell: no X-Org-Id of its own, so the server judged the offer by the login's
// default org («이 QR의 컴퓨터를 찾지 못했어요» for an account in several orgs). Now the QR's computer names its org first (for a member of that org)
// and the key, the list, the offer and the wait all carry it. A server that names none leaves every call exactly as before.
import { describe, expect, it, vi } from 'vitest';
import { checkPairOffer, sendPairOffer, type OfferHead } from './phone-pairing';
import type { PhoneAnswer } from './phone-bridge';

let currentFetch: (url: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error('no server'); };
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (url: string, init?: RequestInit) => currentFetch(url, init) }));

const HEAD: OfferHead = {
  offer_id: '0f3c2a1e-1111-4222-8333-944455556666', setup_id: '12345678-9abc-4def-8123-456789abcdef',
  device_name: 'SYJ-MacBook-Pro', expires_at: '2099-01-01T00:00:00Z',
};
const ORG = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb';
const KEY_ID = '7d1e9c2a-aaaa-4bbb-8ccc-dddddddddddd';
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const shell = (answers: Record<string, PhoneAnswer>) => ({ phoneCall: vi.fn(async (type: string) => answers[type] ?? { id: 'x', ok: false, code: 'bad_request' }) });
const okShell = () => shell({ 'device.key.info': { id: 'x', ok: true, public_key: 'SPKI', key_number: '482 917' }, 'pair.mac': { id: 'x', ok: true, mac: 'MAC' } });

interface Seen { method: string; path: string; org: string | null }
function serverWith(target: () => Response) {
  const seen: Seen[] = [];
  currentFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0]!;
    const h = new Headers(init?.headers);
    seen.push({ method, path, org: h.get('X-Org-Id') });
    if (path === '/api/remote-devices/pairing-target') return target();
    if (method === 'POST' && path === '/api/remote-devices') return res(201, { id: KEY_ID });
    if (method === 'GET' && path === '/api/remote-devices') return res(200, { devices: [{ id: KEY_ID, pairs: [] }] });
    if (method === 'POST' && path === '/api/remote-devices/pairing-offers') return res(202, { state: 'sent' });
    if (path.startsWith('/api/remote-devices/pairing-offers/')) return res(200, { state: 'sent' });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return seen;
}

describe('[4695] the phone sends everything with the QR computer\'s org', () => {
  it('asks the server which org the QR\'s computer is in (by its setup id) BEFORE the key is registered — then the key, the list and the offer carry it', async () => {
    const seen = serverWith(() => res(200, { org_id: ORG }));
    await expect(sendPairOffer(HEAD, 'iPhone', okShell())).resolves.toEqual({ kind: 'sent', phoneKeyId: KEY_ID });
    expect(seen[0]).toEqual({ method: 'GET', path: '/api/remote-devices/pairing-target', org: null }); // the question itself is the login's own
    const rest = seen.slice(1);
    expect(rest.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /api/remote-devices', 'GET /api/remote-devices', 'POST /api/remote-devices/pairing-offers']);
    expect(rest.every((s) => s.org === ORG)).toBe(true); // reverted (no header) → fails
  });

  it('the wait for the computer carries the same org (the offer was made in it)', async () => {
    const seen = serverWith(() => res(200, { org_id: ORG }));
    await sendPairOffer(HEAD, 'iPhone', okShell());
    seen.length = 0;
    await checkPairOffer(HEAD, KEY_ID, null, shell({}));
    expect(seen).toEqual([{ method: 'GET', path: `/api/remote-devices/pairing-offers/${HEAD.offer_id}`, org: ORG }]);
  });

  it('the server names no org (not a member · no such computer · down) → every call goes as it always did: no X-Org-Id', async () => {
    for (const target of [() => res(404, { error: { code: 'setup_not_found' } }), () => res(500), () => { throw new Error('offline'); }, () => res(200, { org_id: 'not-a-uuid' }), () => res(200, {})]) {
      const seen = serverWith(target);
      await sendPairOffer(HEAD, 'iPhone', okShell());
      expect(seen.slice(1).every((s) => s.org === null)).toBe(true);
    }
  });

  it('a different QR\'s answer never leaks onto this one (the org is kept per setup, and re-asked each time)', async () => {
    serverWith(() => res(200, { org_id: ORG }));
    await sendPairOffer(HEAD, 'iPhone', okShell());
    const seen = serverWith(() => res(404, { error: { code: 'setup_not_found' } }));
    await sendPairOffer(HEAD, 'iPhone', okShell()); // the same QR asked again, now with no answer: no stale header
    expect(seen.slice(1).every((s) => s.org === null)).toBe(true);
  });
});
