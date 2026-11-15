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

  it('draft — 검토 안내는 낱말 단위로 줄을 바꾼다(story #4363 · 390/360에서 «승|인» · «검토자|가»로 꺾이던 자리)', async () => {
    stubFetch({});
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const hint = Array.from(container.querySelectorAll('p')).find((el) => el.textContent === koMessages.docs.docGateRequestReviewHint);
    expect(hint, '안내 문구가 렌더된다').toBeTruthy();
    expect(hint?.classList.contains('break-keep')).toBe(true);
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

describe('DocEvidenceRail — 증거 레일(§3/§6, 접힌 audit 리스트→상시 이력 목록)', () => {
  // story 4892 (UI-9 문서 상세 열) — 예전엔 이력 1~2건이면 «컴팩트 스트립»(제목 없음), 3건 이상이면 «세로 타임라인»(제목 있음)으로 갈래가 둘이었다(2967 — 316px 레일이 텅 비어 보이는 결함).
  // 이제 ds 줄 목록 하나(아이콘 + 이름 + 시각)라 건수와 무관하게 같은 모양 — 제목(결재 이력)도 늘 있다. 아래 시험은 그 한 갈래를 건수별로 잰다.
  it('이력이 2건 이하여도 같은 줄 목록으로 뜬다(제목 + 줄들 · 아이콘 · 이름)', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      revisions: [{ id: 'r1', created_by: 'm2', created_at: '2026-08-19T00:00:00Z' }],
      members: [{ id: 'm1', name: '윤도선' }, { id: 'm2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="confirmed" />)); });
    await flush();
    expect(container.textContent).toContain('결재 이력');
    expect(container.querySelectorAll('ol > li').length).toBe(2);
    expect(container.querySelector('[data-testid="doc-evidence-rail"]')?.getAttribute('aria-label')).toBe('결재 이력');
    expect(container.textContent).toContain('검토 요청');
    expect(container.textContent).toContain('승인');
    expect(container.textContent).toContain('윤도선');
    expect(container.textContent).toContain('송윤재');
  });

  it('이력이 3건 이상이어도 같은 줄 목록(제목 + 줄 셋)', async () => {
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
    expect(container.querySelectorAll('ol > li').length).toBe(3);
  });

  // [SID:4311 PR 3] 감사 이력 줄 — 같은 이름 서로 다른 사람 둘이면 «· ID 앞 8자»(행위자 id마다 한 번) · 다른 이름은 꼬리 없음.
  it('[SID:4311 PR 3] 검토 요청 «송윤재» 둘(서로 다른 사람) = 줄마다 id 앞 8자 · 승인자 윤도선 = 꼬리 없음', async () => {
    stubFetch({
      gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })],
      revisions: [
        { id: 'r1', created_by: 'e75ca548-1', created_at: '2026-08-18T00:00:00Z' },
        { id: 'r2', created_by: '2fd14616-2', created_at: '2026-08-19T00:00:00Z' },
      ],
      members: [{ id: 'm1', name: '윤도선' }, { id: 'e75ca548-1', name: '송윤재' }, { id: '2fd14616-2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="confirmed" />)); });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('송윤재 · e75ca548');
    expect(text).toContain('송윤재 · 2fd14616');
    expect(text).toContain('윤도선');
    expect(text).not.toMatch(/윤도선 · [0-9a-f]{8}/);                 // 이름이 유일한 사람은 id 꼬리 없음(뒤의 « · 시각»은 꼬리가 아님)
  });

  // [SID:4311 PR 3] 2건짜리도 같은 표(예전엔 렌더 갈래가 둘이라 따로 재야 했다 — 이제 한 갈래, 그래도 2건 경우를 지킨다).
  it('[SID:4311 PR 3] 2건: 검토 요청 · 다시 요청 «송윤재» 둘(서로 다른 사람) = 줄마다 id 앞 8자', async () => {
    stubFetch({
      revisions: [
        { id: 'r1', created_by: 'e75ca548-1', created_at: '2026-08-18T00:00:00Z' },
        { id: 'r2', created_by: '2fd14616-2', created_at: '2026-08-19T00:00:00Z' },
      ],
      members: [{ id: 'e75ca548-1', name: '송윤재' }, { id: '2fd14616-2', name: '송윤재' }],
    });
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="pending" />)); });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('송윤재 · e75ca548');
    expect(text).toContain('송윤재 · 2fd14616');
    // 꼬리는 RowName 안(이름만 truncate · 꼬리 shrink-0)이라 긴 이름에서도 꼬리가 말줄임에 안 먹힌다
    const parts = [...container.querySelectorAll('[data-row-name-part="tail"]')].map((el) => el.textContent);
    expect(parts.sort()).toEqual([' · 2fd14616', ' · e75ca548']);
  });

  it('이력이 전혀 없으면(draft, gate/revision 0건) 아무것도 렌더하지 않는다(노이즈 0)', async () => {
    stubFetch({});
    const { DocEvidenceRail } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocEvidenceRail docId="doc-1" status="draft" />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});

// story 4892 (UI-9 문서 상세 열) — 상태 머리 · 이력 레일이 ds 부품을 입는다. 승인/반려/서명 로직(요청 몸통 · 서명 흐름의 에디터 유도 · 침묵 실패 없음)은 위 시험이 그대로 지킨다(같은 단정으로 통과) —
// 여기서는 «모양만 바뀌고 길은 안 바뀐다»를 못박는다: 승인은 같은 gateTransition 본문, 반려/서명은 같은 에디터 링크, 옛 ui · lucide · proof 토큰은 없다.
describe('DocStatusHeader · DocEvidenceRail — ds 부품 (4892)', () => {
  it('⭐draft: ds Card + 주 단추(ds Button primary) · 상태 속성(data-state)', async () => {
    stubFetch({});
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="draft" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const card = container.querySelector('[data-testid="doc-status-header"]')!;
    expect(card.getAttribute('data-slot')).toBe('ds-card');
    expect(card.getAttribute('data-state')).toBe('draft');
    const cta = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('검토 요청'))!;
    expect(cta.getAttribute('data-slot')).toBe('ds-button');
    expect(cta.className).toContain('bg-ds-action');
  });

  it('⭐서명 흐름 결재자: 승인 · 반려 단추가 없고 에디터 링크 하나만(ds Button asChild) — 링크는 순수 이동', async () => {
    stubFetch({ gates: [gate({ can_approve: true })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute('href')).toBe(EDIT_HREF);
    expect(links[0]!.getAttribute('data-slot')).toBe('ds-button');
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('⭐저위험 결재자: 반려 = 에디터 링크(위험 단추 모양) · 승인 = ds Button 원탭(같은 본문)', async () => {
    const fetchMock = stubFetch({ gates: [gate({ can_approve: true, risk_grade: 'low' })] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="pending" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const reject = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('반려'))!;
    expect(reject.getAttribute('href')).toBe(EDIT_HREF);                       // 반려는 사유 창이 있는 에디터로 — 여기서 직행 안 함
    expect(reject.className).toContain('border-ds-failed');
    const approve = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('승인'))!;
    expect(approve.getAttribute('data-slot')).toBe('ds-button');
    await act(async () => { approve.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const call = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('/gates/gate-1/transition'));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ status: 'approved', resolver_id: 'member-1' });   // 몸통 한 글자도 안 바뀜
  });

  it('승인됨 · 반려됨 카드는 ds 면(done-soft · failed-soft) 위에 ds ink 글(흐린 글 금지)', async () => {
    stubFetch({ gates: [gate({ status: 'approved', resolver_id: 'm1', resolved_at: '2026-08-21T14:32:00Z' })], members: [{ id: 'm1', name: '윤도선' }] });
    const { DocStatusHeader } = await import('./doc-status-rail');
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="confirmed" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    const card = container.querySelector('[data-testid="doc-status-header"]')!;
    expect(card.className).toContain('bg-ds-done-soft');
    expect(card.querySelector('.text-ds-ink-3')).toBeNull();
    act(() => { root.unmount(); });
    root = createRoot(container);
    stubFetch({ gates: [gate({ status: 'rejected', resolver_id: 'm1', resolved_at: '2026-08-20T00:00:00Z', resolution_note: '근거 부족' })] });
    await act(async () => { root.render(wrap(<DocStatusHeader docId="doc-1" status="denied" editHref={EDIT_HREF} onTransitioned={() => {}} />)); });
    await flush();
    expect(container.querySelector('[data-testid="doc-status-header"]')!.className).toContain('bg-ds-failed-soft');
  });

  it('이력 레일은 ds 부품(SectionHeader · ds Icon)이고 옛 ProofCapsule · lucide · proof 토큰이 없다', async () => {
    const src = (await import('./doc-status-rail.tsx?raw')).default as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/ProofCapsule|lucide-react|from '@\/components\/ui\//);
    expect(code).not.toMatch(/\b(?:proof-[a-z-]+|text-muted-foreground|text-foreground|bg-muted|text-destructive|text-success)\b/);
    // 승인 · 반려 · 서명 길은 그대로: 승인 본문 · 서명 흐름 분기 · 반려 = 에디터 링크
    expect(code).toContain("gateTransition({ status: 'approved', resolver_id: currentTeamMemberId }");
    expect(code).toContain('isApprover && isSigFlow');
  });
});
