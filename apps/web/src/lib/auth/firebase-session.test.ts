import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { NextResponse } from 'next/server';
import {
  _resetKeyCacheForTests,
  setFirebaseSessionCookie,
  verifySprintableSession,
} from './firebase-session';

const PROJECT_ID = 'test-project';
const KID = 'test-kid-1';

// Firebase 세션쿠키 공개키 엔드포인트는 X.509 CERTIFICATE PEM을 반환한다(raw SPKI 아님) —
// jose importX509()가 실제로 요구하는 포맷과 정확히 맞춰 테스트해야 signature 검증 로직 자체를
// 실증한다(raw public key PEM으로는 importX509가 애초에 파싱 실패해 거짓양성 위험 — 직접 확인함).
function makeSelfSignedCert(): { keyPem: string; certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fs-session-test-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=test',
  ], { stdio: 'pipe' });
  return { keyPem: readFileSync(keyPath, 'utf8'), certPem: readFileSync(certPath, 'utf8') };
}

async function makeSessionCookie(
  keyPem: string,
  overrides: { iss?: string; aud?: string; sub?: string; authTime?: number; kid?: string } = {},
): Promise<string> {
  const privateKey = await importPKCS8(keyPem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ auth_time: overrides.authTime ?? now, email: 'user@test.com' })
    .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? KID })
    .setIssuer(overrides.iss ?? `https://session.firebase.google.com/${PROJECT_ID}`)
    .setAudience(overrides.aud ?? PROJECT_ID)
    .setSubject(overrides.sub ?? 'firebase-uid-1')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

describe('verifySprintableSession', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _resetKeyCacheForTests();
  });

  it('accepts a correctly signed session cookie with matching iss/aud/kid', async () => {
    const { keyPem, certPem } = makeSelfSignedCert();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'cache-control': 'max-age=3600' }),
      json: async () => ({ [KID]: certPem }),
    });
    const cookie = await makeSessionCookie(keyPem);
    const result = await verifySprintableSession(cookie, PROJECT_ID);
    expect(result).not.toBeNull();
    expect(result?.firebaseUid).toBe('firebase-uid-1');
    expect(result?.email).toBe('user@test.com');
  });

  it('rejects wrong issuer (issuer confusion — ID token issuer instead of session issuer)', async () => {
    const { keyPem, certPem } = makeSelfSignedCert();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ [KID]: certPem }),
    });
    const cookie = await makeSessionCookie(keyPem, {
      iss: `https://securetoken.google.com/${PROJECT_ID}`, // ID token issuer, not session
    });
    const result = await verifySprintableSession(cookie, PROJECT_ID);
    expect(result).toBeNull();
  });

  it('rejects wrong project (audience mismatch)', async () => {
    const { keyPem, certPem } = makeSelfSignedCert();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ [KID]: certPem }),
    });
    const cookie = await makeSessionCookie(keyPem, { aud: 'other-project' });
    const result = await verifySprintableSession(cookie, PROJECT_ID);
    expect(result).toBeNull();
  });

  it('rejects unknown kid (key not in published set)', async () => {
    const { keyPem, certPem } = makeSelfSignedCert();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ 'some-other-kid': certPem }),
    });
    const cookie = await makeSessionCookie(keyPem, { kid: KID });
    const result = await verifySprintableSession(cookie, PROJECT_ID);
    expect(result).toBeNull();
  });

  it('rejects expired token', async () => {
    const { keyPem, certPem } = makeSelfSignedCert();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ [KID]: certPem }),
    });
    const privateKey = await importPKCS8(keyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ auth_time: now - 7200 })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://session.firebase.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject('firebase-uid-1')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(privateKey);
    const result = await verifySprintableSession(expired, PROJECT_ID);
    expect(result).toBeNull();
  });

  it('rejects a token signed with a different (untrusted) key — wrong signature', async () => {
    const { certPem } = makeSelfSignedCert(); // published cert
    const { keyPem: attackerKeyPem } = makeSelfSignedCert(); // attacker's own keypair, different cert
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      json: async () => ({ [KID]: certPem }), // server only trusts the real published cert
    });
    const forged = await makeSessionCookie(attackerKeyPem); // signed with attacker key, claims trusted kid
    const result = await verifySprintableSession(forged, PROJECT_ID);
    expect(result).toBeNull();
  });
});

describe('setFirebaseSessionCookie — __Host-sp_fs domain-less regression guard (story e5225c0a 3차 근본 재발 방지)', () => {
  it('sets the cookie WITHOUT a Domain attribute even when NEXT_PUBLIC_COOKIE_DOMAIN is configured', () => {
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.sprintable.ai';
    process.env['NEXT_PUBLIC_COOKIE_DOMAIN'] = 'app.sprintable.ai';
    try {
      const response = NextResponse.json({ data: { ok: true } });
      setFirebaseSessionCookie(response, 'fake-session-cookie-value');
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('__Host-sp_fs=fake-session-cookie-value');
      expect(setCookie).not.toContain('Domain=');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toContain('HttpOnly');
    } finally {
      delete process.env['NEXT_PUBLIC_APP_URL'];
      delete process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
    }
  });
});
