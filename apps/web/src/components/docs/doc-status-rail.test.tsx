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
import { useDocGateData } from './doc-status-rail';

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

const EDIT_HREF = '/ws1/proj1/docs/payments-v2';

// PR#3384 카디르 QA CRITICAL(2026-08-23) — 기본값을 risk_grade='high'로 고정한다. BE
// gate_service.derive_risk_grade가 doc_approval을 org posture=permissive가 아닌 한 항상
// high로 등재(_HIGH_RISK_GATE_TYPES, story #6c89e40d ⓐ')하므로, 이게 «흔치 않은 예외»가
// 아니라 실사용 기본값이다 — 예전 기본값 'low'는 정확히 이 gap을 가려 QA가 실물에서
// 터질 때까지 여기서 안 잡혔다(비현실적 픽스처가 진짜 결함을 가린 사례, #2955 요약 참고).
function gate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1', org_id: 'org-1', work_item_id: 'doc-1', work_item_type: 'doc', gate_type: 'doc_approval',
    status: 'pending', resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    source: 'gate', can_approve: true, risk_grade: 'high',
    ...overrides,
  } as GateItem;
}

function stubFetch({ gates = [], revisions = [], members = [] }: { gates?: GateItem[]; revisions?: Array<{ id: string; created_by?: string; created_at?: string }>; members?: Array<{ id: string; name: string }> }) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
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
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('검토 요청');
  });

  it('draft — CTA 클릭 시 POST .../transition에 status=pending이 실린다', async () => {
    const fetchMock = stubFetch({});
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('검토 요청'));
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'));
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ status: 'pending' });
  });

  // PR#3384 카디르 QA CRITICAL 처방 검증 — doc_approval 기본값(risk_grade='high')은
  // usesSignatureFlow=true다. 리더는 이 경우 승인/반려를 직행시키지 않고 에디터로만
  // 유도한다(그 경로가 GateSignatureApproval을 갖고 있다 — 리더에 새로 짓지 않음).
  it('pending + 결재 자격자 + 서명 필요(기본 risk_grade=high) — 승인/반려 버튼 없이 에디터 유도 링크만 뜬다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ can_approve: true })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('검토 중');
    expect(container.textContent).toContain('에디터에서 서명 결재');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('승인'))).toBe(false);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.includes('반려'))).toBe(false);
    const link = container.querySelector('a[href]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(EDIT_HREF);
    // 링크 자체는 순수 네비게이션 — 렌더만으로 게이트 전이 fetch가 나가면 안 된다(우회 금지).
    expect(fetchMock.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes('/gates/'))).toBe(false);
  });

  it('pending + 결재 자격자 + 저위험(risk_grade=low, 예: org posture=permissive) — 원탭 승인/반려가 그대로 동작한다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ can_approve: true, risk_grade: 'low' })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).not.toContain('에디터에서 서명 결재');
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('승인'));
    expect(approveBtn).toBeTruthy();
    await act(async () => { approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/gates/gate-1/transition'));
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ status: 'approved', resolver_id: 'member-1' });
  });

  it('전이 실패(422 등) — 침묵 실패 없이 에러 문구를 표시한다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/gates?')) return new Response(JSON.stringify([gate({ can_approve: true, risk_grade: 'low' })]), { status: 200 });
      if (url.includes('/revisions')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.includes('/team-members')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.includes('/transition')) return new Response(JSON.stringify({ error: { message: 'evidence_viewed가 필요합니다' } }), { status: 422 });
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('승인'));
    await act(async () => { approveBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain('evidence_viewed가 필요합니다');
  });

  it('pending + 비자격자(저자 등) — 액션 없이 대기 문구만 뜬다(self-approval 금지)', async () => {
    stubFetch({ gates: [gate({ can_approve: false })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
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
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="confirmed" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('승인됨');
    expect(container.textContent).toContain('윤도선');
  });

  it('denied — 반려 사유와 "수정" 버튼이 뜨고, 클릭 시 draft로 되돌린다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ status: 'rejected', resolver_id: 'm1', resolved_at: '2026-08-20T00:00:00Z', resolution_note: '근거 부족' })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="denied" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.textContent).toContain('반려됨');
    expect(container.textContent).toContain('근거 부족');
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('수정'));
    await act(async () => { editBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/transition'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ status: 'draft' });
  });
});

// PR#3384 카디르 QA 선택 처방 — "gateTransition 안전판 줄(isSigFlow면 거부)을 빼도 기존
// 테스트가 안 깨진다"는 뮤테이션 gap. UI가 버튼을 안 그리는 것과 무관하게, 데이터 레이어
// 함수 자체가 우회를 거부하는지 직접 호출로 검증한다(useDocGateData를 테스트 전용 export).
function GateTransitionHarness({ docId, status }: { docId: string; status: string }) {
  const { gateTransition } = useDocGateData(docId, status);
  return (
    <button data-testid="raw-attempt" onClick={() => void gateTransition({ status: 'approved', resolver_id: 'member-1' }, () => {})}>
      go
    </button>
  );
}

describe('gateTransition 데이터 레이어 안전판(§ 우회 금지, UI 은닉과 별개)', () => {
  it('isSigFlow=true(기본 risk_grade=high)면 UI를 우회해 직접 호출해도 게이트 전이 fetch가 안 나간다', async () => {
    const fetchMock = stubFetch({ gates: [gate({ can_approve: true })] });
    await act(async () => {
      root.render(wrap(<GateTransitionHarness docId="doc-1" status="pending" />));
    });
    await flush();
    const btn = container.querySelector('[data-testid="raw-attempt"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(fetchMock.mock.calls.some((c) => typeof c[0] === 'string' && (c[0] as string).includes('/gates/gate-1/transition'))).toBe(false);
  });
});

describe('DocEvidenceRail — 증거 레일(§3/§6, 접힌 audit 리스트→상시 타임라인)', () => {
  // story #2967(선생님 실사용 판정 ④) — 이력 1~2건은 316px 세로 레일이 텅 비어 보여 판이
  // 왼쪽으로 쏠렸다. 노드 2개 이하는 세로선·제목 없이 컴팩트 가로 스트립으로 강등한다.
  it('이력이 2건 이하면 세로 타임라인(제목·세로선) 없이 컴팩트 스트립으로 뜬다', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      revisions: [{ id: 'r1', created_by: 'm2', created_at: '2026-08-19T00:00:00Z' }],
      members: [{ id: 'm1', name: '윤도선' }, { id: 'm2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="confirmed" />)); });
    await flush();
    expect(container.textContent).not.toContain('결재 이력');
    expect(container.querySelector('ol')).toBeNull();
    expect(container.textContent).toContain('검토 요청');
    expect(container.textContent).toContain('승인');
    expect(container.textContent).toContain('윤도선');
    expect(container.textContent).toContain('송윤재');
  });

  it('이력이 3건 이상이면 세로 타임라인(제목·세로선 있는 정규 레일)으로 뜬다', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      revisions: [
        { id: 'r1', created_by: 'm2', created_at: '2026-08-18T00:00:00Z' },
        { id: 'r2', created_by: 'm2', created_at: '2026-08-19T00:00:00Z' },
      ],
      members: [{ id: 'm1', name: '윤도선' }, { id: 'm2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="confirmed" />)); });
    await flush();
    expect(container.textContent).toContain('결재 이력');
    expect(container.querySelector('ol')).not.toBeNull();
  });

  it('이력이 전혀 없으면(draft, gate/revision 0건) 아무것도 렌더하지 않는다(노이즈 0)', async () => {
    stubFetch({});
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="draft" />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});
