// @vitest-environment jsdom
//
// story #4298(PO 06:15Z) — 스탠드업 화면이 실 BE 계약대로 돈다.
// - «안 쓴 사람»: BE `[{id, name}]`(BFF가 data로 감쌈)를 이름 칩으로 · 이름 모름(null)은 «이름 없는 구성원» · 조회 실패는 빈 목록과 다른 문장.
// - 피드백 작성 · 수정 · 삭제: fetchWithAuth(401 → 토큰 갱신 · 재시도) · 작성 본문에 신원(org · 작성자) 없음 + 보는 프로젝트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

type DialogProps = {
  onCreateFeedback: (input: { standup_entry_id: string; review_type: 'comment'; feedback_text: string }) => Promise<void>;
  onUpdateFeedback: (id: string, input: { feedback_text?: string }) => Promise<void>;
  onDeleteFeedback: (id: string) => Promise<void>;
};

const { useDashboardContextMock, fetchWithAuthMock, dialogProps } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  fetchWithAuthMock: vi.fn(),
  dialogProps: { current: null as DialogProps | null },
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: () => null }));
vi.mock('@/components/standup/board-bridge-modal', () => ({ BoardBridgeModal: () => null }));
vi.mock('@/components/standup/standup-history-section', () => ({ StandupHistorySection: () => null }));
vi.mock('@/components/standup/standup-board-card', () => ({
  StandupBoardCard: ({ member, onOpenFeedback }: { member: { id: string }; onOpenFeedback: () => void }) => (
    <button type="button" data-testid={`open-${member.id}`} onClick={onOpenFeedback}>open</button>
  ),
}));
vi.mock('@/components/standup/standup-feedback-dialog', () => ({
  StandupFeedbackDialog: (props: DialogProps) => { dialogProps.current = props; return null; },
}));
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let rawFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  dialogProps.current = null;
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [] });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  fetchWithAuthMock.mockReset();
});

function setup(missing: { ok: boolean; body: unknown }) {
  const respond = async (url: string, init?: RequestInit) => {
    if (url.includes('/api/standup?date=')) return { ok: true, json: async () => ({ data: [{ id: 'e-other', author_id: 'other-1', date: '2026-09-25', done: '', plan: '', blockers: null, plan_story_ids: [] }] }) };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [{ id: 'me-1', name: '나', type: 'human' }, { id: 'other-1', name: '동료', type: 'human' }] }) };
    if (url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/standup/missing')) return { ok: missing.ok, json: async () => missing.body };
    if (url.includes('/api/standup/feedback')) return { ok: true, status: init?.method === 'DELETE' ? 200 : 200, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  };
  fetchWithAuthMock.mockImplementation(respond);
  rawFetch = vi.fn(respond);
  vi.stubGlobal('fetch', rawFetch);
}

async function mount() {
  const { default: StandupPage } = await import('./standup-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><StandupPage projectId="proj-1" /></NextIntlClientProvider>);
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('StandupClient — «안 쓴 사람»(story #4298)', () => {
  it('BE `[{id, name}]`를 이름 칩으로 · 이름 모름(null)은 «이름 없는 구성원» — 이메일 · UUID를 그리지 않는다', async () => {
    setup({ ok: true, body: { data: [{ id: 'm-1', name: '비' }, { id: 'm-2', name: null }] } });
    await mount();
    expect(container.textContent).toContain(koMessages.standup.missingOrgStandup);
    expect(container.textContent).toContain('비');
    expect(container.textContent).toContain(koMessages.common.memberUnnamed);
    expect(container.textContent).not.toContain('m-2');
    expect(container.querySelector('[data-testid="standup-missing-load-failed"]')).toBeNull();
  });

  it('조회 실패는 빈 목록(칸 없음)과 다른 문장으로 말한다', async () => {
    setup({ ok: false, body: { error: { code: 'INTERNAL' } } });
    await mount();
    expect(container.querySelector('[data-testid="standup-missing-load-failed"]')?.textContent).toBe(koMessages.standup.missingLoadFailed);
  });

  it('음성대조 — 빈 배열(모두 씀)이면 칸도 실패 문장도 없다', async () => {
    setup({ ok: true, body: { data: [] } });
    await mount();
    expect(container.textContent).not.toContain(koMessages.standup.missingOrgStandup);
    expect(container.textContent).not.toContain(koMessages.standup.missingLoadFailed);
  });
});

describe('StandupClient — 피드백 작성 · 수정 · 삭제(story #4298)', () => {
  it('셋 다 fetchWithAuth로 가고 · 작성 본문엔 신원 없이 보는 프로젝트만 붙는다', async () => {
    setup({ ok: true, body: { data: [] } });
    await mount();
    await act(async () => { (container.querySelector('[data-testid="open-other-1"]') as HTMLButtonElement).click(); });
    expect(dialogProps.current).not.toBeNull();
    const props = dialogProps.current as DialogProps;
    await act(async () => { await props.onCreateFeedback({ standup_entry_id: 'e-other', review_type: 'comment', feedback_text: '좋아요' }); });
    await act(async () => { await props.onUpdateFeedback('fb-1', { feedback_text: '고침' }); });
    await act(async () => { await props.onDeleteFeedback('fb-1'); });

    const mutations = fetchWithAuthMock.mock.calls.filter(([, init]) => init && (init as RequestInit).method && (init as RequestInit).method !== 'GET');
    expect(mutations.map(([url, init]) => `${(init as RequestInit).method} ${url}`)).toEqual([
      'POST /api/standup/feedback',
      'PATCH /api/standup/feedback/fb-1',
      'DELETE /api/standup/feedback/fb-1',
    ]);
    const body = JSON.parse(String((mutations[0][1] as RequestInit).body));
    expect(body).toEqual({ standup_entry_id: 'e-other', review_type: 'comment', feedback_text: '좋아요', project_id: 'proj-1' });
    expect(rawFetch.mock.calls.some(([, init]) => init && (init as RequestInit).method && (init as RequestInit).method !== 'GET')).toBe(false);
  });
});
