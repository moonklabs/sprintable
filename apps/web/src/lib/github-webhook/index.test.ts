import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { extractTicketIds, verifyGitHubSignature } from './index';

const SECRET = 'test-secret-abc';

function sign(body: string): string {
  const sig = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
  return `sha256=${sig}`;
}

describe('verifyGitHubSignature', () => {
  it('returns true for correct HMAC', async () => {
    const body = JSON.stringify({ action: 'opened' });
    expect(await verifyGitHubSignature(SECRET, body, sign(body))).toBe(true);
  });

  it('returns false for tampered body', async () => {
    const body = '{"action":"opened"}';
    expect(await verifyGitHubSignature(SECRET, body + ' ', sign(body))).toBe(false);
  });

  it('returns false for wrong secret', async () => {
    const body = '{}';
    const wrongSig = `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`;
    expect(await verifyGitHubSignature(SECRET, body, wrongSig)).toBe(false);
  });

  it('returns false when header is null', async () => {
    expect(await verifyGitHubSignature(SECRET, '{}', null)).toBe(false);
  });

  it('returns false when header missing sha256= prefix', async () => {
    expect(await verifyGitHubSignature(SECRET, '{}', 'abc123')).toBe(false);
  });
});

describe('extractTicketIds', () => {
  it('extracts SPR-N from title', () => {
    expect(extractTicketIds('feat: login [SPR-42]', null)).toEqual(['SPR-42']);
  });

  it('extracts from body closes pattern', () => {
    expect(extractTicketIds('some PR', 'closes SPR-7')).toEqual(['SPR-7']);
  });

  it('extracts from body fixes pattern', () => {
    expect(extractTicketIds('fix', 'fixes SPR-100')).toEqual(['SPR-100']);
  });

  it('extracts multiple ticket IDs', () => {
    const ids = extractTicketIds('SPR-1 and SPR-2', 'closes SPR-3');
    expect(ids.sort()).toEqual(['SPR-1', 'SPR-2', 'SPR-3']);
  });

  it('deduplicates same ticket ID', () => {
    expect(extractTicketIds('SPR-5', 'closes SPR-5')).toEqual(['SPR-5']);
  });

  it('normalizes to uppercase', () => {
    expect(extractTicketIds('spr-10', null)).toEqual(['SPR-10']);
  });

  it('returns empty array when no tickets', () => {
    expect(extractTicketIds('refactor: cleanup', null)).toEqual([]);
  });
});
