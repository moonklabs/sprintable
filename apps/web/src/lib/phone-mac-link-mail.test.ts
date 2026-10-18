// story #4714 AC2 — sendMacLinkMail: the call carries nothing, and every end is one outcome. «sent» only for a delivered mail.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const { sendMacLinkMail } = await import('./phone-mac-link-mail');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { fetchWithAuth.mockReset(); });

describe('sendMacLinkMail', () => {
  it('POSTs to the web route with no body and no query (no address goes from here)', async () => {
    fetchWithAuth.mockResolvedValue(json({ delivered: true, email: 'own@example.test' }));
    await sendMacLinkMail();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/desktop/mac-link-mail');
    expect(init).toEqual({ method: 'POST' });
  });

  it('delivered:true → sent with the account\'s own address (raw or {data} envelope)', async () => {
    fetchWithAuth.mockResolvedValueOnce(json({ delivered: true, email: 'own@example.test' }));
    expect(await sendMacLinkMail()).toEqual({ kind: 'sent', email: 'own@example.test' });
    fetchWithAuth.mockResolvedValueOnce(json({ data: { delivered: true, email: 'own@example.test' }, error: null }));
    expect(await sendMacLinkMail()).toEqual({ kind: 'sent', email: 'own@example.test' });
  });

  it('delivered:false is a failure, never «sent»; so is an answer without the address or one that is not JSON', async () => {
    fetchWithAuth.mockResolvedValueOnce(json({ delivered: false, email: 'own@example.test' }));
    expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
    fetchWithAuth.mockResolvedValueOnce(json({ delivered: true }));
    expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
    fetchWithAuth.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
    fetchWithAuth.mockResolvedValueOnce(json(null));
    expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
  });

  it('429 → limited; 409 email_not_verified → need_verify; 409 download_not_enabled → not_enabled', async () => {
    fetchWithAuth.mockResolvedValueOnce(json({ error: { code: 'rate_limited' } }, 429));
    expect(await sendMacLinkMail()).toEqual({ kind: 'limited' });
    fetchWithAuth.mockResolvedValueOnce(json({ error: { code: 'email_not_verified' } }, 409));
    expect(await sendMacLinkMail()).toEqual({ kind: 'need_verify' });
    fetchWithAuth.mockResolvedValueOnce(json({ error: { code: 'download_not_enabled' } }, 409));
    expect(await sendMacLinkMail()).toEqual({ kind: 'not_enabled' });
  });

  it('any other refusal, a 5xx and a lost answer are a failure (403 person_session_required included)', async () => {
    for (const res of [json({ error: { code: 'person_session_required' } }, 403), json({}, 500), json({}, 503), json({ error: { code: 'other' } }, 409)]) {
      fetchWithAuth.mockResolvedValueOnce(res);
      expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
    }
    fetchWithAuth.mockRejectedValueOnce(new Error('network'));
    expect(await sendMacLinkMail()).toEqual({ kind: 'failed' });
  });
});
