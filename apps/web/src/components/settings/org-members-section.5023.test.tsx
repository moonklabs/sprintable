// @vitest-environment jsdom
//
// story 5023 (B2-2, b) — the invitation screen on a server that sends no mail: the words after an invitation is made say that NOTHING was sent and the link is the person's to hand over; the pending list says it per row
// (and a row whose mail went out says nothing extra). Mounted for real, same harness as the 4891 test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { OrgMembersSection } from './org-members-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let invitesAnswer: unknown[];
let postAnswer: Record<string, unknown>;
const MEMBERS = [{ id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@x.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' }];

beforeEach(() => {
  invitesAnswer = []; postAnswer = {};
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-owner' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: MEMBERS });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: invitesAnswer });
    if (url === '/api/projects') return ok({ data: [] });
    if (method === 'POST') return ok({ data: postAnswer });
    throw new Error('unexpected fetch: ' + url);
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
async function draw(locale: 'ko' | 'en' = 'ko') {
  await act(async () => { root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><OrgMembersSection orgId="org-1" currentRole="owner" /></NextIntlClientProvider>); });
  await flush();
}
const typeInto = async (el: HTMLInputElement, v: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }); await flush(); };
const press = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
async function invite(locale: 'ko' | 'en' = 'ko') {
  await draw(locale);
  await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, 'new@x.com');
  const label = locale === 'ko' ? koMessages.settings.invite : enMessages.settings.invite;
  await press([...container.querySelectorAll('button')].find((b) => b.textContent === label));
}
const banner = () => container.querySelector('[data-slot="ds-banner"]')?.textContent ?? '';

describe('the words after an invitation is made', () => {
  it('the mail went out: «invite sent» and the link, as before', async () => {
    postAnswer = { invite_url: 'https://team.example.com/invite/accept?token=t1', email_sent_at: '2026-11-25T10:00:00Z', email_error: null };
    await invite();
    expect(banner()).toBe(`${koMessages.settings.orgMemberInviteSuccess} — https://team.example.com/invite/accept?token=t1`);
  });
  it('NO mail went out (no sent time · or an error): «nothing was sent — copy the link and hand it over», with the link, in both languages', async () => {
    for (const answer of [{ invite_url: 'https://team.example.com/invite/accept?token=t2', email_sent_at: null, email_error: 'no provider' }, { invite_url: 'https://team.example.com/invite/accept?token=t2' }, { invite_url: 'https://team.example.com/invite/accept?token=t2', email_sent_at: '2026-11-25T10:00:00Z', email_error: 'late failure' }]) {
      postAnswer = answer; await invite();
      expect(banner()).toBe(`${koMessages.settings.orgMemberInviteNoMail} — https://team.example.com/invite/accept?token=t2`);
      expect(banner()).not.toContain(koMessages.settings.orgMemberInviteSuccess);
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
    postAnswer = { invite_url: 'https://team.example.com/invite/accept?token=t3', email_sent_at: null };
    await invite('en');
    expect(banner()).toBe(`${enMessages.settings.orgMemberInviteNoMail} — https://team.example.com/invite/accept?token=t3`);
  });
});

describe('the pending list', () => {
  it('a row whose mail did not go out says so (the link is the way); a row whose mail went out says nothing more; a row with no link says nothing either', async () => {
    invitesAnswer = [
      { id: 'a', email: 'nomail@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://team.example.com/invite/accept?token=a', email_sent_at: null, email_error: 'no provider' },
      { id: 'b', email: 'sent@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://team.example.com/invite/accept?token=b', email_sent_at: '2026-11-25T10:00:00Z', email_error: null },
      { id: 'd', email: 'late-failure@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://team.example.com/invite/accept?token=d', email_sent_at: '2026-11-25T10:00:00Z', email_error: 'SMTP failed' }, // the same «sent» rule as the words after an invitation: a mail with an error is NOT sent
      { id: 'e', email: 'neither@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://team.example.com/invite/accept?token=e', email_sent_at: null, email_error: null }, // no sent time and no error word: still not sent
      { id: 'c', email: 'nolink@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', email_sent_at: null }, // pending, mail not sent, but NO link to copy: nothing to tell the person to hand over
    ];
    await draw();
    const notes = [...container.querySelectorAll('[data-testid="org-invite-no-mail-note"]')];
    expect(container.textContent).toContain('nolink@x.com'); // the row with no link IS drawn — and says nothing extra
    expect(notes).toHaveLength(3); expect(notes.every((n) => n.textContent === koMessages.settings.orgInviteNoMailNote)).toBe(true);
    const who = notes.map((n) => n.closest('div.min-w-0')?.textContent ?? '').join('|');
    for (const e of ['nomail@x.com', 'late-failure@x.com', 'neither@x.com']) expect(who).toContain(e);
    expect(notes.every((n) => !(n.closest('div.min-w-0')?.textContent ?? '').includes('sent@x.com'))).toBe(true);
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await draw('en');
    expect(container.querySelector('[data-testid="org-invite-no-mail-note"]')?.textContent).toBe(enMessages.settings.orgInviteNoMailNote);
  });
});
