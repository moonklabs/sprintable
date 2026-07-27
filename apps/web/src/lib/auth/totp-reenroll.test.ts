import { describe, expect, it } from 'vitest';
import { shouldPromptTotpReenroll } from './totp-reenroll';

describe('shouldPromptTotpReenroll (doc firebase-auth-login-ux-blueprint §2 S3 4번 — 이중 게이팅)', () => {
  it('is false when the client flag is off, even if BE says totp_enabled=true', () => {
    expect(shouldPromptTotpReenroll(false, true)).toBe(false);
  });

  it('is false when BE has not returned totp_enabled at all (undefined — current live state)', () => {
    expect(shouldPromptTotpReenroll(true, undefined)).toBe(false);
  });

  it('is false when BE explicitly says totp_enabled=false', () => {
    expect(shouldPromptTotpReenroll(true, false)).toBe(false);
  });

  it('is true only when both the flag is on AND BE explicitly confirms totp_enabled=true', () => {
    expect(shouldPromptTotpReenroll(true, true)).toBe(true);
  });
});
