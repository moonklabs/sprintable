// @vitest-environment jsdom
//
// story #2955 §3/§7(doc docs-index-reader-redesign-handoff) — 셸 B 상태 헤더 캡슐+증거
// 레일. doc-gate-section.test.tsx와 동형 fetch 모킹 관례(같은 API 계약을 독립적으로
// 다시 구성했으므로 — 에디터 표면을 안 건드리기 위한 의도적 중복, 파일 상단 주석 참조).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1', org_id: 'org-1', work_item_id: 'doc-1', work_item_type: 'doc', gate_type: 'doc_approval',
    status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    source: 'gate', can_approve: true, risk_grade: 'low',
    ...overrides,
  } as GateItem;
}

function stubFetch({ gates = [], revisions = [], members = [] }: { gates?: GateItem[]; revisions?: Array<{ id: string; created_by?: string; created_at?: string }>; members?: Array<{ id: string; name: string }> }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/gates?')) return new Response(JSON.stringify(gates), { status: 200 });
    if (typeof url === 'string' && url.includes('/revisions')) return new Response(JSON.stringify({ data: revisions }), { status: 200 });
    if (typeof url === 'string' && url.includes('/team-members')) return new Response(JSON.stringify({ data: members }), { status: 200 });
    if (typeof url === 'string' && url.includes('/transition')) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1' });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('DocStatusHeader — 상태별 렌더(§3, 접힌 박스→상시 캡슐 승격)', () => {
  it('draft — "검토 요청" CTA가 상시 노출된다', async () => {
    stubFetch({});
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('검토 요청');
  });

  it('draft — CTA 클릭 시 POST .../transition에 status=pending이 실린다', async () => {
    const fetchMock = stubFetch({});
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" onTransitioned={() => {}} />)); });
    await flush();
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('검토 요청'));
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'));
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ status: 'pending' });
  });

  it('pending + 결재 자격자 — 승인/반려 버튼이 뜨고, 승인 클릭 시 gate transition이 발화한다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ can_approve: true })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('검토 중');
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('승인'));
    expect(approveBtn).toBeTruthy();
    await act(async () => { approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/gates/gate-1/transition'));
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ status: 'approved', resolver_id: 'member-1' });
  });

  it('pending + 비자격자(저자 등) — 액션 없이 대기 문구만 뜬다(self-approval 금지)', async () => {
    stubFetch({ gates: [gate({ can_approve: false })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('검토자의 응답 대기 중');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('승인'))).toBe(false);
  });

  it('confirmed — 결재자 이름과 시각이 뜬다', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      members: [{ id: 'm1', name: '윤도선' }],
    });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="confirmed" onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('승인됨');
    expect(container.textContent).toContain('윤도선');
  });

  it('denied — 반려 사유와 "수정" 버튼이 뜨고, 클릭 시 draft로 되돌린다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ status: 'rejected', resolver_id: 'm1', resolved_at: '2026-08-20T00:00:00Z', resolution_note: '근거 부족' })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="denied" onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('반려됨');
    expect(container.textContent).toContain('근거 부족');
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('수정'));
    await act(async () => { editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ status: 'draft' });
  });
});

describe('DocEvidenceRail — 증거 레일(§3/§6, 접힌 audit 리스트→상시 타임라인)', () => {
  it('revision+승인 이력이 있으면 타임라인 노드가 렌더된다', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      revisions: [{ id: 'r1', created_by: 'm2', created_at: '2026-08-19T00:00:00Z' }],
      members: [{ id: 'm1', name: '윤도선' }, { id: 'm2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="confirmed" />)); });
    await flush();
    expect(container.textContent).toContain('결재 이력');
    expect(container.textContent).toContain('검토 요청');
    expect(container.textContent).toContain('승인');
    expect(container.textContent).toContain('윤도선');
    expect(container.textContent).toContain('송윤재');
  });

  it('이력이 전혀 없으면(draft, gate/revision 0건) 아무것도 렌더하지 않는다(노이즈 0)', async () => {
    stubFetch({});
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="draft" />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});
