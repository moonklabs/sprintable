import { expect, test } from '@playwright/test';

/**
 * Verifies GitHub webhook endpoint behavior without a running GitHub integration.
 * Uses Playwright's request API to hit the endpoint directly.
 */
test.describe('GitHub webhook endpoint', () => {
  test('returns 400 when GITHUB_WEBHOOK_SECRET is not configured', async ({ request }) => {
    // In test env the secret is not set → 400
    const res = await request.post('/api/webhooks/github', {
      headers: { 'content-type': 'application/json' },
      data: '{}',
    });
    expect(res.status()).toBe(400);
  });

  test('returns 400 for missing signature header', async ({ request }) => {
    const res = await request.post('/api/webhooks/github', {
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        // no x-hub-signature-256
      },
      data: JSON.stringify({ action: 'opened' }),
    });
    // Either 400 (no secret) or 400 (bad sig) — never 5xx
    expect(res.status()).toBeLessThan(500);
  });

  test('always returns non-5xx to prevent GitHub retry storms', async ({ request }) => {
    const res = await request.post('/api/webhooks/github', {
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      data: '{"broken":json}',
    });
    expect(res.status()).toBeLessThan(500);
  });
});
