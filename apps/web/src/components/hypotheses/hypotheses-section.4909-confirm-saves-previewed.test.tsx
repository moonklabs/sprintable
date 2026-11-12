// @vitest-environment jsdom
//
// 4909 (나) — «확인하고 추가» saved a NEW draft, not the one the person read. The preview came from POST /api/hypotheses/draft {persist:false}; the confirm called the same endpoint again
// with {persist:true}, so the server generated another draft (the statement is LLM-written, the measure date is «now + N days»). What is saved must be the previewed draft:
// the confirm sends the previewed values to the existing create API (POST /api/hypotheses) and never asks the server to draft again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1' }) }));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { HypothesesSection } from './hypotheses-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[];

const PREVIEWED = {
  statement: '미리 보인 가설 문장 — 첫 화면에 후기를 넣으면 체류가 는다',
  metric_definition: { metric: 'session_minutes', source: 'manual', target: 3, direction: 'up' },
  measure_after: '2026-11-26T03:04:05.000Z',
  source_snapshot: { epic_title: '랜딩 개편' },
  confidence: null, requires_confirmation: true, hypothesis: null,
};
const OTHER = { ...PREVIEWED, statement: '서버가 다시 지은 전혀 다른 문장', measure_after: '2026-11-27T09:00:00.000Z' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  fetchWithAuthMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: [] }) }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  fetchWithAuthMock.mockReset();
  vi.unstubAllGlobals();
});

const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
const btn = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

/** `createOk: false` = the create request fails. The draft endpoint answers PREVIEWED the first time and OTHER every later time (a regenerated draft). */
async function mount(opts: { createOk?: boolean } = {}) {
  let draftCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (url === '/api/hypotheses/draft') { draftCalls += 1; return { ok: true, json: async () => ({ data: draftCalls === 1 ? PREVIEWED : OTHER }) }; }
    if (url === '/api/hypotheses' && method === 'POST') return { ok: opts.createOk !== false, status: opts.createOk === false ? 500 : 201, json: async () => ({ data: { id: 'h-new' } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }));
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HypothesesSection epicId="e1" projectId="proj-1" /></NextIntlClientProvider>);
  });
  await flush();
  await act(async () => { btn(koMessages.hypotheses.draftCta)!.click(); });
  await flush();
}

describe('[SID:4909] HypothesesSection — «확인하고 추가» saves the draft the person READ', () => {
  it('⭐the previewed text is on screen, and the confirm sends exactly those values (statement · metric · measure date) to the create API as a proposed row on this epic', async () => {
    await mount();
    expect(container.textContent).toContain(PREVIEWED.statement);
    await act(async () => { btn(koMessages.hypotheses.draftAccept)!.click(); });
    await flush();
    const created = calls.filter((c) => c.url === '/api/hypotheses' && c.method === 'POST');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({
      project_id: 'proj-1', epic_ids: ['e1'], status: 'proposed', source_type: 'epic', source_id: 'e1',
      statement: PREVIEWED.statement, // reverted → the server's regenerated «전혀 다른 문장»
      metric_definition: PREVIEWED.metric_definition,
      measure_after: PREVIEWED.measure_after,
      draft_metadata: { source_snapshot: PREVIEWED.source_snapshot },
    });
  });

  it('⭐the confirm never asks the server to draft AGAIN (no second /api/hypotheses/draft call, no persist:true)', async () => {
    await mount();
    await act(async () => { btn(koMessages.hypotheses.draftAccept)!.click(); });
    await flush();
    const draftCalls = calls.filter((c) => c.url === '/api/hypotheses/draft');
    expect(draftCalls).toHaveLength(1); // the preview only
    expect(draftCalls[0]!.body).toMatchObject({ persist: false });
    expect(calls.some((c) => (c.body as { persist?: boolean } | null)?.persist === true)).toBe(false);
  });

  it('after a saved confirm the preview closes; when the save FAILS the preview stays so the person can try again (nothing is lost)', async () => {
    await mount();
    await act(async () => { btn(koMessages.hypotheses.draftAccept)!.click(); });
    await flush();
    expect(container.textContent).not.toContain(PREVIEWED.statement);

    await act(async () => { root.unmount(); });
    container.remove(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    calls = [];
    await mount({ createOk: false });
    await act(async () => { btn(koMessages.hypotheses.draftAccept)!.click(); });
    await flush();
    expect(container.textContent).toContain(PREVIEWED.statement);
    expect(btn(koMessages.hypotheses.draftAccept)).toBeTruthy();
  });
});
