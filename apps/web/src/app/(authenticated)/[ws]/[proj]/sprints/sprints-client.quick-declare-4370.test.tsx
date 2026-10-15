// @vitest-environment jsdom
/**
 * story #4370(까디르 P2) — 옆 패널 «가설 빠르게 선언» 저장: fetchWithAuth는 4xx/5xx에도 던지지 않는다. 예전엔 응답을 안 보고
 * 초안을 지워, 저장이 실패해도 쓴 선언이 사라졌다. 이제 저장 못 한 선언은 초안에 남고 오류 줄이 뜬다 · 전부 저장돼야 지운다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';
import { EMPTY_DECLARATION } from '@/services/hypothesis-declaration';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => <div>{title}{actions}</div>,
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({ WorkspaceFrameTabs: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sp = koMessages.sprints as unknown as Record<string, string>;
const SPRINT = { id: 'sp-1', title: '스프린트 1', status: 'planning', start_date: '2026-09-01', end_date: '2026-09-14' };
const DRAFT_KEY = 'sprintable:field-draft:v1:u:-:sprint-quick-hypotheses:sp-1:form'; // story #4490 — owner segment (none set: -)
const LINKED = { ...EMPTY_DECLARATION, mode: 'link' as const, linkedHypothesisId: 'h-1', linkedPreview: { statement: '온보딩을 줄이면 완료율이 오른다', status: 'draft' } };

let container: HTMLDivElement;
let root: Root;
let postOk = false;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [SPRINT] }) };
    if (url.includes('/api/sprints/sp-1/hypotheses') && init?.method === 'POST') return { ok: postOk, status: postOk ? 201 : 500, json: async () => ({}) };
    if (url.includes('/api/sprints/sp-1/hypotheses')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify([LINKED]));  // 이미 써 둔 선언(초안)
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);

async function openQuickDeclare() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SprintsClient projectId="proj-1" orgId="org-1" />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  const row = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === SPRINT.title)!.closest('li')!;
  await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
  await act(async () => { button(sp.declareAddCta)!.click(); });
  await settle();
}

describe('스프린트 옆 패널 빠른 가설 선언 — 저장 실패는 초안을 지우지 않는다(story #4370 · 까디르 P2)', () => {
  it('POST 500 → 오류 줄 · 선언은 초안에 그대로', async () => {
    postOk = false;
    await openQuickDeclare();
    await act(async () => { button(sp.declareSectionTitle)!.click(); });
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(sp.quickDeclareError);
    const kept = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? 'null') as Array<{ linkedHypothesisId: string }> | null;
    expect(kept?.map((d) => d.linkedHypothesisId)).toEqual(['h-1']);
  });

  it('전부 저장되면 초안을 지운다', async () => {
    postOk = true;
    await openQuickDeclare();
    await act(async () => { button(sp.declareSectionTitle)!.click(); });
    await settle();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('보이는 «취소»는 선언 초안을 버리고 폼을 접는다', async () => {
    postOk = true;
    await openQuickDeclare();
    await act(async () => { button(sp.cancel)!.click(); });
    await settle();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(button(sp.declareSectionTitle)).toBeUndefined();
    expect(button(sp.declareAddCta)).toBeDefined();
  });
});

