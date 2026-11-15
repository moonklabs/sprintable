// @vitest-environment jsdom
//
// 4909 (마) — the hypothesis row's «스토리 연결» menu item was DEAD: its handler was an empty function («후속 배선»), so pressing it did nothing. It is now wired to the story picker that already exists
// (components/canvas/story-picker-dialog) and the link request that already exists (POST /api/hypotheses/{id}/links — the same request the story panel's «연결된 가설» sends, link_type=supports).
// No new screen part, no new endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1' }) }));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { HypothesesSection } from './hypotheses-section';
import { ORG_NAMES_URL } from '@/hooks/use-member-name-fallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];
let listReads: number;

function hypothesis(id: string): Hypothesis {
  return {
    id, org_id: 'org-1', project_id: 'proj-1', owner_member_id: 'm-1', created_by_member_id: null, confirmed_by_member_id: null,
    statement: `가설 ${id}`, metric_definition: { metric: 'activation', target: 10, direction: 'up' } as never, measure_after: '2026-12-01T00:00:00Z',
    status: 'active', outcome_result: null, confidence: null, source_type: null, source_id: null, human_accounting: {}, gate_contract: {},
    epic_ids: ['e1'], story_ids: [], created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
  } as Hypothesis;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  listReads = 0;
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/hypotheses?')) { listReads += 1; return { ok: true, json: async () => ({ data: [hypothesis('h1')] }) }; }
    if (url === ORG_NAMES_URL) return { ok: true, json: async () => ({ data: [{ id: 'm-1', name: '담당자' }] }) };
    if (url.startsWith('/api/gates')) return { ok: true, json: async () => [] }; // the section reads these as plain arrays
    return { ok: true, json: async () => ({ data: [] }) };
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.body.innerHTML = '';
  fetchWithAuthMock.mockReset();
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); await flush(); };
const T = koMessages.hypotheses;

/** `linkMode`: how the links request answers. */
async function mount(linkMode: { current: 'ok' | 'http-error' | 'throws' } = { current: 'ok' }) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (url.startsWith('/api/stories')) return { ok: true, json: async () => ({ data: [{ id: 's1', title: '가격 페이지 만들기' }, { id: 's2', title: '후기 모으기' }], meta: { hasMore: false } }) };
    if (url.endsWith('/links') && method === 'POST') {
      if (linkMode.current === 'throws') throw new TypeError('Failed to fetch');
      return { ok: linkMode.current === 'ok', status: linkMode.current === 'ok' ? 200 : 500, json: async () => ({ data: {} }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HypothesesSection epicId="e1" projectId="proj-1" /></NextIntlClientProvider>);
  });
  await flush();
}

async function pressLinkStoryMenuItem() {
  const trigger = container.querySelector(`[aria-label="${T.actions}"]`);
  await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const item = [...document.body.querySelectorAll('[role="menuitem"], [data-slot="dropdown-menu-item"]')].find((el) => el.textContent?.includes(T.linkStory));
  expect(item).toBeTruthy();
  await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await wait(350); // the picker reads the story list after its 250 ms search delay
}
const pickStory = async (title: string) => {
  const b = [...document.body.querySelectorAll('[data-slot="dialog-content"] button')].find((x) => x.textContent === title);
  expect(b).toBeTruthy();
  await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
};
const linkPosts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/links'));
const dialog = () => document.body.querySelector('[data-slot="dialog-content"]');

describe('[SID:4909] HypothesesSection — «스토리 연결» does something', () => {
  it('⭐the menu item opens the story picker (reverted → the item does nothing: no dialog, no story read)', async () => {
    await mount();
    await pressLinkStoryMenuItem();
    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain(koMessages.canvas.storyPickerTitle);
    expect(dialog()!.textContent).toContain('가격 페이지 만들기');
    expect(calls.some((c) => c.url.startsWith('/api/stories') && c.url.includes('project_id=proj-1'))).toBe(true);
    expect(dialog()!.textContent).not.toContain(koMessages.canvas.storyPickerSkip); // «스토리 없이 만들기» is for artifacts — not offered here
  });

  it('⭐picking a story sends the existing link request for THAT hypothesis and story (link_type supports), closes the picker and re-reads the list', async () => {
    await mount();
    const readsBefore = listReads;
    await pressLinkStoryMenuItem();
    await pickStory('후기 모으기');
    expect(linkPosts()).toHaveLength(1);
    expect(linkPosts()[0]!.url).toBe('/api/hypotheses/h1/links');
    expect(linkPosts()[0]!.body).toEqual({ story_ids: ['s2'], link_type: 'supports' });
    expect(dialog()).toBeNull();
    expect(listReads).toBeGreaterThan(readsBefore); // the 🔗 count comes from a fresh read
    expect(container.querySelector('[data-testid="hypothesis-link-failed"]')).toBeNull();
  });

  it('closing the picker without choosing sends nothing', async () => {
    await mount();
    await pressLinkStoryMenuItem();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect(linkPosts()).toHaveLength(0);
  });

  it('⭐a link request answered with an error says so (not silent) and the next successful link clears the line', async () => {
    const mode = { current: 'http-error' } as { current: 'ok' | 'http-error' | 'throws' };
    await mount(mode);
    await pressLinkStoryMenuItem();
    await pickStory('가격 페이지 만들기');
    expect(container.querySelector('[data-testid="hypothesis-link-failed"]')?.textContent).toBe(T.linkStoryFailed);
    mode.current = 'ok';
    await pressLinkStoryMenuItem();
    expect(container.querySelector('[data-testid="hypothesis-link-failed"]')).toBeNull(); // opening it again clears the old line
    await pickStory('가격 페이지 만들기');
    expect(container.querySelector('[data-testid="hypothesis-link-failed"]')).toBeNull();
  });

  it('⭐a link request that THROWS (network) says so too', async () => {
    await mount({ current: 'throws' });
    await pressLinkStoryMenuItem();
    await pickStory('후기 모으기');
    expect(container.querySelector('[data-testid="hypothesis-link-failed"]')?.textContent).toBe(T.linkStoryFailed);
  });
});
