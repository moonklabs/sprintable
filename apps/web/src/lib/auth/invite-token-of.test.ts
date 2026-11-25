// story 5023 — the invitation token that rides on a sign-up request: read from the `next` of the invitation journey, from this site's own invitation path only.
import { describe, expect, it } from 'vitest';
import { inviteTokenOf } from './invite-token-of';

describe('inviteTokenOf', () => {
  it('the token of /invite/accept?token=… (other query parts around it are fine)', () => {
    expect(inviteTokenOf('/invite/accept?token=abc123')).toBe('abc123');
    expect(inviteTokenOf('/invite/accept?x=1&token=a1b2_c.d~e-f&y=2')).toBe('a1b2_c.d~e-f');
    expect(inviteTokenOf(`/invite/accept?token=${'a'.repeat(64)}`)).toBe('a'.repeat(64));
    expect(inviteTokenOf(`/invite/accept?token=${encodeURIComponent('abc123')}`)).toBe('abc123');
  });
  it('anything else is no token: another path, another site, no token, an odd or over-long one, nothing', () => {
    for (const bad of [null, '', '/', '/inbox', '/invite/accept', '/invite/accept?token=', '/invite?token=abc', '/invite/accept/x?token=abc', '//evil.example/invite/accept?token=abc', 'https://evil.example/invite/accept?token=abc', 'javascript:alert(1)',
      '/invite/accept?token=a b', '/invite/accept?token=a%0Ab', '/invite/accept?token=<script>', `/invite/accept?token=${'a'.repeat(201)}`, '/INVITE/accept?token=abc', '/invite/accept#token=abc',
      // the stand-in base must never make a non-local address look like this site's own path
      'http://invite.invalid/invite/accept?token=abc', '//invite.invalid/invite/accept?token=abc', 'invite/accept?token=abc', '/\\invite.invalid/invite/accept?token=abc', '\\/invite/accept?token=abc', ' /invite/accept?token=abc']) {
      expect(inviteTokenOf(bad as string | null), String(bad)).toBeNull();
    }
  });
});
