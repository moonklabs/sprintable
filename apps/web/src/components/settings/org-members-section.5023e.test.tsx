// @vitest-environment jsdom
//
// story 5023 (e) — an invitation link made while a workspace server has no public address opens only on the server computer: the screen says so beside the link (and in the pending list),
// and says nothing when the server says the link is usable. Mounted for real, same harness as the 5023 invitation test.
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
let postFails = false;
const MEMBERS = [{ id: 'row-owner', user_id: 'u-owner', name: '오너', email: 'owner@x.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' }];

beforeEach(() => {
  invitesAnswer = []; postAnswer = {}; postFails = false;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const ok = (data: unknown) => ({ ok: true, json: async () => data });
    if (url === '/api/me') return ok({ data: { user_id: 'u-owner' } });
    if (url === '/api/org-members' && method === 'GET') return ok({ data: MEMBERS });
    if (url === '/api/organizations/org-1/invites' && method === 'GET') return ok({ data: invitesAnswer });
    if (url === '/api/projects') return ok({ data: [] });
    if (method === 'POST') return postFails ? { ok: false, status: 500, json: async () => ({ error: { code: 'X' } }) } : ok({ data: postAnswer });
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

const NOTE = '[data-testid="org-invite-link-local-note"]';
const CMD = '[data-testid="org-invite-link-local-note-command"]';
const ROW_NOTE = '[data-testid="org-invite-link-local-row-note"]';
const LOCAL = 'http://localhost:3000/invite/accept?token=L1';

describe('a link that opens only on the server computer says so', () => {
  it('just made: the banner keeps its sentence and link as before, and the one extra line (ko and en) stands under it', async () => {
    postAnswer = { invite_url: LOCAL, email_sent_at: null, email_error: null, link_is_local: true };
    await invite();
    expect(banner()).toBe(`${koMessages.settings.orgMemberInviteNoMail} — ${LOCAL}`);
    expect(container.querySelector(`${NOTE} p`)?.textContent).toBe(koMessages.settings.orgInviteLinkLocalNote);
    expect(container.querySelector(CMD)?.textContent).toBe('sprintable-host server set-public-origin https://team.example.com --restart'); // the command is its own line, not in the sentence
    expect(koMessages.settings.orgInviteLinkLocalNote).not.toContain('sprintable-host');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await invite('en');
    expect(container.querySelector(`${NOTE} p`)?.textContent).toBe(enMessages.settings.orgInviteLinkLocalNote);
  });
  it('a link the server says is usable (or says nothing about: an older server): no extra line', async () => {
    for (const extra of [{ link_is_local: false }, {}]) {
      postAnswer = { invite_url: 'https://team.example.com/invite/accept?token=U1', email_sent_at: null, ...extra };
      await invite();
      expect(container.querySelector(NOTE)).toBeNull();
      await act(async () => { root.unmount(); }); root = createRoot(container);
    }
  });
  it('a failed invitation never shows it, and a second attempt clears the line of the first', async () => {
    postAnswer = { invite_url: LOCAL, email_sent_at: null, link_is_local: true };
    await invite();
    expect(container.querySelector(NOTE)).toBeTruthy();
    postFails = true;  // the second attempt fails: the first one's line must not stay under a failure banner
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, 'again@x.com');
    await press([...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.settings.invite));
    expect(container.querySelector(NOTE)).toBeNull();
    expect(banner()).toBe(koMessages.settings.memberInviteFailed);
    postFails = false;  // and a third, good one with a usable link: still none
    postAnswer = { invite_url: 'https://team.example.com/invite/accept?token=U2', email_sent_at: null, link_is_local: false };
    await typeInto(container.querySelector('input[type="email"]') as HTMLInputElement, 'third@x.com');
    await press([...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.settings.invite));
    expect(container.querySelector(NOTE)).toBeNull();
  });
  it('the pending list: a local link\'s row says it; a usable link\'s row and a row with no link do not', async () => {
    invitesAnswer = [
      { id: 'a', email: 'local@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: LOCAL, email_sent_at: null, email_error: null, link_is_local: true },
      { id: 'b', email: 'public@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', invite_url: 'https://team.example.com/invite/accept?token=P', email_sent_at: null, email_error: null, link_is_local: false },
      { id: 'c', email: 'nolink@x.com', role: 'member', status: 'pending', expires_at: '2099-01-01T00:00:00Z', link_is_local: true },
    ];
    await draw();
    const notes = [...container.querySelectorAll(ROW_NOTE)];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.closest('div.min-w-0')?.textContent).toContain('local@x.com');
  });
});
