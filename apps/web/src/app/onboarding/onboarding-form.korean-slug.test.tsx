// @vitest-environment jsdom
//
// story 4669 (U6 · AC2) — the organization carries no slug: the server derives it (org_project_create.py: the ASCII part, or
// `workspace-<8 hex>`, made unique). Story 4715 — the organization-name field is gone too: the name is made («{name}의 조직» from a
// Korean display name), and the request still carries the name only. Reverted (a slug or a field back) → `slug` in the body / an input.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { OnboardingForm } from './onboarding-form';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(locale: 'ko' | 'en') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      <OnboardingForm todayHref="/today" chatsHref="/chats" />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/onboarding/events') return { ok: true, json: async () => ({}) };
    if (url === '/api/auth/me') return { ok: true, json: async () => ({ data: { member_id: 'u-1', email_verified: true, org_id: null, org_member_id: null, display_name: '문클랩스' } }) };
    if (url === '/api/invites/mine') return { ok: true, json: async () => ({ invites: [] }) }; // the backend's one shape (no envelope)
    if (url === '/api/auth/refresh') return { ok: true, json: async () => ({}) };
    if (url === '/api/organizations') {
      return { ok: true, json: async () => ({ data: { id: 'org-korean-1', slug: 'workspace-3f9a1c2b' } }) };
    }
    // the one screen's download card · phone card — not this test's matter
    return { ok: false, status: 404, json: async () => ({}) };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
}

describe.each([
  ['ko', koMessages, '문클랩스의 조직'] as const,
  ['en', enMessages, "문클랩스's organization"] as const,
])('[SID:4669 · 4715] OnboardingForm — no slug, no name field: the made name alone makes the organization (locale=%s)', (locale, messages, made) => {
  it('no text input · no slug wording on screen', async () => {
    await act(async () => { root.render(wrap(locale)); });
    await flush();
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(0); // reverted (the name field) → 1
    expect(container.textContent).not.toContain('URL');
    expect(container.textContent).not.toContain('slug');
  });

  it('POST /api/organizations carries the made name only — the slug is the server\'s', async () => {
    await act(async () => { root.render(wrap(locale)); });
    await flush();
    const orgCall = vi.mocked(fetch).mock.calls.find((c) => c[0] === '/api/organizations');
    expect(orgCall).not.toBeUndefined();
    expect(JSON.parse((orgCall![1] as RequestInit).body as string)).toEqual({ name: made }); // reverted → has `slug`
    // and on to the one screen (4715) — its Mac or not-Mac face follows the test runner's user agent
    expect([messages.onboarding.first.macTitle, messages.onboarding.first.notMacTitle]).toContain(container.querySelector('h1')?.textContent);
  });
});
