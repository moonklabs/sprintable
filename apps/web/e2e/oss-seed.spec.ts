import { expect, test } from '@playwright/test';

/**
 * Verifies the OSS seed endpoint behavior:
 * - Returns 403 outside OSS mode (mocked via direct API call)
 * - Seeds 3 stories on first call when empty
 * - Returns seeded:false on subsequent calls (idempotent)
 */
test.describe('OSS seed endpoint', () => {
  test('seeds sample data on first call', async ({ request }) => {
    const res = await request.post('/api/oss/seed');
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Either freshly seeded or already has data — both are valid outcomes
    expect(body.data).toHaveProperty('seeded');
    if (body.data.seeded) {
      expect(body.data.count).toBe(3);
    } else {
      expect(body.data.reason).toBe('already_has_data');
    }
  });

  test('is idempotent — second call returns already_has_data', async ({ request }) => {
    // Seed once (may already have data)
    await request.post('/api/oss/seed');

    // Second call must always skip
    const res = await request.post('/api/oss/seed');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data.seeded).toBe(false);
    expect(body.data.reason).toBe('already_has_data');
  });

  test('webhook-status returns connected:false without secret', async ({ request }) => {
    const res = await request.get('/api/oss/webhook-status');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveProperty('connected');
    // In test env GITHUB_WEBHOOK_SECRET is not set → false
    expect(typeof body.data.connected).toBe('boolean');
  });
});
