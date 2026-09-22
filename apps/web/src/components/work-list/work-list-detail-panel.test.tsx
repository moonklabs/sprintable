// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { WorkListDetailPanel } from './work-list-detail-panel';
import type { WorkListRow } from './derive-work-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #3845 — ArtifactSection/EvidenceSection은 각자 자기 fetch·자기 테스트 스위트를
// 가진 무거운 컴포넌트다(story-detail-panel.tsx 기존 재사용 관례) — 이 패널의 테스트
// 관심사는 "그 컴포넌트에 올바른 props를 넘기는가"뿐이라 얇은 stub으로 대체한다(실
// fetch·실 렌더는 각 컴포넌트 자신의 스위트가 이미 검증).
vi.mock('@/components/verify/evidence-section', () => ({
  EvidenceSection: (props: { workItemId: string; workItemType: string; selfReported: unknown }) => (
    <div data-testid="stub-evidence-section" data-work-item-id={props.workItemId} data-work-item-type={props.workItemType} data-self-reported={String(props.selfReported)} />
  ),
}));
vi.mock('@/components/canvas/artifact-section', () => ({
  ArtifactSection: (props: { storyId: string }) => <div data-testid="stub-artifact-section" data-story-id={props.storyId} />,
}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

const { dashboardContextRef } = vi.hoisted(() => ({
  dashboardContextRef: { current: { currentMemberType: 'human' as 'human' | 'agent' | undefined } },
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => dashboardContextRef.current,
}));

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function baseRow(overrides: Partial<WorkListRow> = {}): WorkListRow {
  return {
    id: 'row-1', kind: 'task', workItemType: 'task', workItemId: 'task-1',
    title: '일 제목', ownerName: '디디', isDelegated: false, lowRisk: false, artifactCount: 0,
    state: 'awaiting_approval',
    ...overrides,
  };
}

function jsonResponse(data: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 300,
    status: init.status ?? 200,
    json: async () => ({ data }),
  };
}

/** 이 패널이 마운트 시 병렬로 던지는 4개 fetch(story·hypotheses·backlinks·gates)를
 * url 패턴으로 분기해 응답한다 — 순서에 기대지 않는다(Promise.all 등가, 실 구현이
 * 순서를 바꿔도 이 테스트가 안 깨진다). */
function mockFetchRoutes(routes: {
  story?: unknown;
  hypotheses?: unknown[];
  docs?: unknown[];
  gates?: unknown[];
  artifacts?: unknown[];
  transitionStatus?: number;
  // story #3976
  tasks?: unknown[];
  activityLogItems?: unknown[];
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes('/transition')) {
      return jsonResponse({ id: 'g1', status: 'approved' }, { status: routes.transitionStatus ?? 200 });
    }
    if (url.startsWith('/api/stories/') && url.endsWith('/backlinks?source_type=doc')) {
      return jsonResponse(routes.docs ?? []);
    }
    if (url.startsWith('/api/stories/')) {
      return jsonResponse(routes.story ?? null);
    }
    if (url.startsWith('/api/hypotheses')) {
      return jsonResponse(routes.hypotheses ?? []);
    }
    if (url.startsWith('/api/visual-artifacts')) {
      return jsonResponse(routes.artifacts ?? []);
    }
    if (url.startsWith('/api/tasks?story_id=')) {
      return jsonResponse(routes.tasks ?? []);
    }
    if (url.startsWith('/api/activity-logs')) {
      return jsonResponse({ items: routes.activityLogItems ?? [] });
    }
    if (url.startsWith('/api/gates')) {
      return jsonResponse(routes.gates ?? []);
    }
    return jsonResponse(null, { status: 404 });
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  dashboardContextRef.current = { currentMemberType: 'human' };
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

async function mountPanel(
  row: WorkListRow = baseRow(),
  storyId = 'story-1',
  extra: { isHiddenByFilter?: boolean; onClearFilters?: () => void } = {},
) {
  await act(async () => {
    root.render(wrap(
      <WorkListDetailPanel row={row} storyId={storyId} storyTitle="스토리 제목" goalTitle="목표 제목" onClose={() => {}} {...extra} />,
    ));
  });
  // 4개 fetch(async 체인)가 정착할 때까지 마이크로태스크 몇 바퀴 더 돈다.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('WorkListDetailPanel — 헤더', () => {
  it('제목·「어디에 속하나」·담당·상태를 그대로 그린다', async () => {
    // 카디르 계약값 ⑥(페드루 판정 2026-09-14 10:55Z) — 상태 줄은 이제 row.state 스냅샷이
    // 아니라 fresh gate에서 재계산된다(같은 fetch 소스로 주 액션 버튼과 통일). 이 fixture가
    // gates:[] 그대로였다면 row.state='awaiting_approval'(baseRow 기본값)이 fresh gate 부재로
    // 억제돼(AC③) 렌더 0이 되므로, 실제로 그 상태가 맞다고 fresh gate로도 확認해 준다.
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel(baseRow({ title: '문서 초안 작성', ownerName: '유나' }));
    expect(container.textContent).toContain('문서 초안 작성');
    expect(container.querySelector('[data-testid="panel-belongs-to"]')?.textContent).toContain('목표 제목');
    expect(container.querySelector('[data-testid="panel-belongs-to"]')?.textContent).toContain('스토리 제목');
    expect(container.querySelector('[data-testid="panel-assignee"]')?.textContent).toContain('유나');
    expect(container.querySelector('[data-testid="panel-state"]')?.textContent).toContain(koMessages.workList.stateAwaitingApproval);
  });

  it('카디르 계약값 ⑥(a): row.state=null(목록 로드 시점엔 게이트 없었음) + fresh gate pending → 헤더 상태 줄+주 액션 버튼 둘 다 뜬다(같은 fresh gate에서 파생)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel(baseRow({ state: null }));
    expect(container.querySelector('[data-testid="panel-state"]')?.textContent).toContain(koMessages.workList.stateAwaitingApproval);
    expect(container.querySelector('[data-testid="panel-primary-action"]')).not.toBeNull();
  });

  it('카디르 계약값 ⑥(b): row.state=awaiting_approval(스냅샷) + fresh 결과 없음(승인/거절돼 사라짐) → 상태 줄·버튼 둘 다 안 뜬다(스냅샷 낱말을 그대로 안 믿는다)', async () => {
    mockFetchRoutes({ gates: [] });
    await mountPanel(baseRow({ state: 'awaiting_approval' }));
    expect(container.querySelector('[data-testid="panel-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
  });

  it('담당 없음(ownerName=null)이면 「배정 없음」(지어내지 않는다)', async () => {
    mockFetchRoutes({});
    await mountPanel(baseRow({ ownerName: null }));
    expect(container.querySelector('[data-testid="panel-assignee"]')?.textContent).toContain(koMessages.workList.panelAssigneeNone);
  });
});

describe('WorkListDetailPanel — 픽셀 커밋 ①(필터 가려진 행 ?row= 딥링크, 페드루 PO 판정 2026-09-14 09:11Z)', () => {
  it('⭐isHiddenByFilter=false(기본)면 안내 배너가 안 뜬다', async () => {
    mockFetchRoutes({});
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-hidden-by-filter-notice"]')).toBeNull();
  });

  it('⭐isHiddenByFilter=true면 패널은 여전히 뜨고(row 자체는 정상 렌더) 안내 배너+필터 지우기 버튼이 함께 뜬다', async () => {
    mockFetchRoutes({});
    await mountPanel(baseRow({ title: '가려진 행' }), 'story-1', { isHiddenByFilter: true });
    expect(container.querySelector('[data-testid="work-list-detail-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('가려진 행');
    const notice = container.querySelector('[data-testid="panel-hidden-by-filter-notice"]');
    expect(notice?.textContent).toContain(koMessages.workList.panelHiddenByFilter);
    expect(container.querySelector('[data-testid="panel-clear-filters"]')?.textContent).toBe(koMessages.workList.panelClearFilters);
  });

  it('⭐필터 지우기 클릭 — onClearFilters가 정확히 1회 호출된다', async () => {
    mockFetchRoutes({});
    const onClearFilters = vi.fn();
    await mountPanel(baseRow(), 'story-1', { isHiddenByFilter: true, onClearFilters });
    const btn = container.querySelector('[data-testid="panel-clear-filters"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});

describe('WorkListDetailPanel — 탭→데이터 매핑', () => {
  it('⭐근거 탭 — 가설 목록+EvidenceSection에 정확히 이 storyId·work_item_type=story가 실린다', async () => {
    mockFetchRoutes({
      hypotheses: [{ id: 'h1', statement: '가설 문장 A', status: 'active' }],
      story: { self_reported: true, human_verified: null, human_verified_by: null, human_verified_at: null },
    });
    await mountPanel(baseRow(), 'story-42');
    expect(container.querySelector('[data-testid="panel-hypotheses-list"]')?.textContent).toContain('가설 문장 A');
    const stub = container.querySelector('[data-testid="stub-evidence-section"]');
    expect(stub?.getAttribute('data-work-item-id')).toBe('story-42');
    expect(stub?.getAttribute('data-work-item-type')).toBe('story');
    expect(stub?.getAttribute('data-self-reported')).toBe('true');
  });

  it('⭐문서 탭 — backlinks 응답 doc 제목만 뜨고, 다른 탭(가설·산출물) 데이터는 안 섞인다', async () => {
    mockFetchRoutes({
      docs: [{ id: 'ref1', doc: { id: 'doc1', title: '연결된 문서 제목' }, still_exists: true }],
      hypotheses: [{ id: 'h1', statement: '가설 문장 A', status: 'active' }],
    });
    await mountPanel();
    // Base UI Tabs는 활성 패널만 DOM에 싣는다(마운트 유지 아님) — 문서 탭을 눌러야
    // panel-docs-list가 실제로 나타난다.
    await act(async () => { (container.querySelector('[data-testid="panel-tab-docs"]') as HTMLElement).click(); });
    const docsList = container.querySelector('[data-testid="panel-docs-list"]');
    expect(docsList?.textContent).toContain('연결된 문서 제목');
    // 문서 목록 안에 가설 문장이 섞여 들어오지 않는다(탭 분리 확認).
    expect(docsList?.textContent).not.toContain('가설 문장 A');
  });

  it('문서 탭 — 0건이면 「연결된 문서가 없어요」', async () => {
    mockFetchRoutes({ docs: [] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-docs"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-docs-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyDocs);
  });

  it('⭐산출물 탭 — ArtifactSection에 정확히 이 storyId가 실린다(1건 이상일 때만 렌더)', async () => {
    mockFetchRoutes({ artifacts: [{ id: 'a1' }] });
    await mountPanel(baseRow(), 'story-99');
    await act(async () => { (container.querySelector('[data-testid="panel-tab-artifacts"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="stub-artifact-section"]')?.getAttribute('data-story-id')).toBe('story-99');
  });

  // story #3976 AC2 — 「일」 체크리스트(기존 GET /api/tasks?story_id= 재사용, 새 BE 0).
  it('⭐일 탭 — task 제목+상태 라벨(entity-status-labels.ts SSOT)이 뜬다', async () => {
    mockFetchRoutes({ tasks: [{ id: 't1', title: '시안 그리기', status: 'in-progress' }, { id: 't2', title: 'PO 렌더 검수', status: 'todo' }] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-tasks"]') as HTMLElement).click(); });
    const list = container.querySelector('[data-testid="panel-tasks-list"]');
    expect(list?.textContent).toContain('시안 그리기');
    expect(list?.textContent).toContain('진행 중');
    expect(list?.textContent).toContain('PO 렌더 검수');
    expect(list?.textContent).toContain('할 일');
  });

  it('일 탭 — 0건이면 「아직 일로 안 나뉘었어요」', async () => {
    mockFetchRoutes({ tasks: [] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-tasks"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-tasks-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyTasks);
  });

  // story #3976 CHANGES(페드루 PO C1, 2026-09-17 00:38Z, dev 실측 3픽스처 — moonklabs
  // 스토리 로그 100건: story_updated의 81%에 context.old_status/new_status·14%에
  // context.fields). action 원시값·필드명 원시값은 노출 0, 실측 모양 그대로 검증.
  it('⭐이력 탭 — 생성은 그대로, 상태 전후 있으면 SSOT 라벨로 「상태를 X → Y로」', async () => {
    mockFetchRoutes({
      activityLogItems: [
        { id: 'l1', actor_name: '페드루', action: 'story_created', created_at: new Date().toISOString(), context: {} },
        { id: 'l2', actor_name: '유나', action: 'story_updated', created_at: new Date().toISOString(), context: { old_status: 'in-progress', new_status: 'in-review' } },
      ],
    });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-history"]') as HTMLElement).click(); });
    const list = container.querySelector('[data-testid="panel-history-list"]');
    expect(list?.textContent).toContain('페드루가 만들었어요');
    expect(list?.textContent).toContain('유나가 상태를 진행 중 → 검토 중으로 바꿨어요');
    expect(list?.textContent).not.toContain('story_created');
    expect(list?.textContent).not.toContain('in-progress');
  });

  it('⭐이력 탭 — fields만 있으면(status 전후 없음) §3875 유형 라벨로 「{필드} 바꿨어요」', async () => {
    mockFetchRoutes({
      activityLogItems: [
        { id: 'l3', actor_name: '디디', action: 'story_updated', created_at: new Date().toISOString(), context: { fields: ['title'] } },
      ],
    });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-history"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-history-list"]')?.textContent).toContain('디디가 제목을 바꿨어요');
  });

  it('⭐이력 탭 — 미등록 필드(story_points 등)·근거 부재는 중립 폴백 「그 밖의 변경」 1개로(원시 필드명 노출 0)', async () => {
    mockFetchRoutes({
      activityLogItems: [
        { id: 'l4', actor_name: '미르코', action: 'story_updated', created_at: new Date().toISOString(), context: { fields: ['story_points', 'priority'] } },
      ],
    });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-history"]') as HTMLElement).click(); });
    const list = container.querySelector('[data-testid="panel-history-list"]');
    expect(list?.textContent).toContain('미르코가 그 밖의 변경을 했어요');
    expect(list?.textContent).not.toContain('story_points');
    expect(list?.textContent).not.toContain('priority');
  });

  it('이력 탭 — 0건이면 「아직 이력이 없어요」', async () => {
    mockFetchRoutes({ activityLogItems: [] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-history"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-history-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyHistory);
  });

  // 픽셀 커밋 CHANGES 2(페드루 PO 판정 09:40Z) — 3탭 다 "아직 로딩 중"과 "진짜 0건"을
  // 구분한 빈 상태 1줄(muted) — ArtifactSection 자체의 무거운 CTA empty-state는 이
  // 360px 패널엔 안 맞아(전체 캔버스 전용 설계) 이 패널이 artifactCount로 직접 가른다.
  it('근거 탭 — 가설 0건이면 「아직 연결된 가설이 없어요」', async () => {
    mockFetchRoutes({ hypotheses: [] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-hypotheses-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyHypotheses);
  });

  it('산출물 탭 — 0건이면 「연결된 산출물이 없어요」(ArtifactSection 자체 CTA 미노출)', async () => {
    mockFetchRoutes({ artifacts: [] });
    await mountPanel();
    await act(async () => { (container.querySelector('[data-testid="panel-tab-artifacts"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-artifacts-empty"]')?.textContent).toBe(koMessages.workList.panelEmptyArtifacts);
    expect(container.querySelector('[data-testid="stub-artifact-section"]')).toBeNull();
  });

  it('⭐산출물 탭 로딩 중 — fetch가 아직 안 끝났으면 「없어요」도 ArtifactSection도 안 뜬다(로딩=다른 상태)', async () => {
    let resolveArtifacts: (v: Response) => void = () => {};
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/visual-artifacts')) {
        return new Promise<Response>((resolve) => { resolveArtifacts = resolve; });
      }
      return jsonResponse(url.startsWith('/api/gates') ? [] : null);
    });
    await mountPanel(baseRow(), 'story-1');
    await act(async () => { (container.querySelector('[data-testid="panel-tab-artifacts"]') as HTMLElement).click(); });
    expect(container.querySelector('[data-testid="panel-artifacts-loading"]')?.textContent).toBe(koMessages.common.loading);
    expect(container.querySelector('[data-testid="panel-artifacts-empty"]')).toBeNull();
    await act(async () => { resolveArtifacts(jsonResponse([]) as unknown as Response); });
  });
});

describe('WorkListDetailPanel — 위험 pill(gate_type/risk에서만)', () => {
  it('pending gate 0건이면 위험 pill 0(placeholder 아님)', async () => {
    mockFetchRoutes({ gates: [] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-risk"]')).toBeNull();
  });

  it('risk_grade=high면 고위험 뱃지+문장', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-risk"]')?.textContent).toContain(koMessages.workList.riskBadgeHigh);
  });
});

describe('WorkListDetailPanel — 주 액션 라벨 매핑(gate-risk.ts::usesSignatureFlow SSOT)', () => {
  // 저위험(risk_grade='low')만 평문 버튼+「승인」 라벨 — 그 밖은 전부 GateSignatureApproval로
  // 갈린다(픽셀 커밋 ②, 아래 별도 describe가 그 경로를 전담 검증).
  it('risk_grade=low → 평문 버튼·「승인」', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')?.textContent).toBe(koMessages.workList.actionApprove);
    expect(container.querySelector('[data-testid="panel-signature-flow"]')).toBeNull();
  });

  it('⭐risk_grade=null(미분류) → 평문 버튼이 아니라 서명 플로우(gate-risk.ts가 null을 보수적 고위험 취급 — 이 카드가 고친 그 버그의 회귀가드)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: null, status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-signature-flow"]')).not.toBeNull();
  });

  it('gate_type=external_publish·risk=high → 서명 플로우', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'external_publish', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-signature-flow"]')).not.toBeNull();
  });
});

describe('WorkListDetailPanel — 서명 플로우(고위험, 픽셀 커밋 ②: GateSignatureApproval 재사용·evidence_viewed 하드코딩 0)', () => {
  function sigGate() {
    return { id: 'g1', gate_type: 'doc_approval', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' };
  }

  it('⭐근거열람 체크+사유 입력 전엔 승인 버튼이 비활성(GateSignatureApproval 자기 게이팅 그대로)', async () => {
    mockFetchRoutes({ gates: [sigGate()] });
    await mountPanel();
    const flow = container.querySelector('[data-testid="panel-signature-flow"]') as HTMLElement;
    // GateSignatureApproval의 DOM 순서는 [반려, 승인] 고정(gate-signature-approval.tsx) —
    // 승인 버튼은 항상 마지막.
    const btn = [...flow.querySelectorAll('button')].at(-1) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('⭐승인 — 체크박스+사유 입력 뒤 클릭하면 evidence_viewed:true로 POST(하드코딩 0, canSign 게이팅 통과가 그 증거)', async () => {
    mockFetchRoutes({ gates: [sigGate()], transitionStatus: 200 });
    await mountPanel();
    const flow = container.querySelector('[data-testid="panel-signature-flow"]') as HTMLElement;
    const checkbox = flow.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const textarea = flow.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      checkbox.click();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '근거 확인함');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // GateSignatureApproval의 DOM 순서는 [반려, 승인] 고정(gate-signature-approval.tsx) —
    // 체크박스+사유 입력 뒤엔 반려 버튼도 함께 풀리므로(canReject=reason만 필요) !disabled로
    // 찾으면 안 되고 마지막 버튼(승인)을 명시로 집는다.
    const approveBtn = [...flow.querySelectorAll('button')].at(-1) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(false);
    await act(async () => { approveBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const transitionCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const [url, init] = call as [string, RequestInit?];
      return init?.method === 'POST' && url.includes('/transition');
    });
    expect(transitionCall).toBeDefined();
    const body = JSON.parse((transitionCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ status: 'approved', evidence_viewed: true, note: '근거 확인함' });
    expect(container.querySelector('[data-testid="panel-approved-notice"]')?.textContent).toBe(koMessages.workList.actionApproved);
  });

  it('⭐뮤테이션 표적 — 평문 경로는 evidence_viewed:false로 POST(고위험 경로와 혼동 0)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }], transitionStatus: 200 });
    await mountPanel();
    const btn = container.querySelector('[data-testid="panel-primary-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const transitionCall = fetchMock.mock.calls.find((call: unknown[]) => {
      const [url, init] = call as [string, RequestInit?];
      return init?.method === 'POST' && url.includes('/transition');
    });
    const body = JSON.parse((transitionCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ status: 'approved', evidence_viewed: false });
  });
});

describe('WorkListDetailPanel — 에이전트 뷰어 403 회피', () => {
  it('⭐currentMemberType=agent면 pending gate가 있어도 주 액션 버튼 자체가 없다(평문 경로)', async () => {
    dashboardContextRef.current = { currentMemberType: 'agent' };
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
  });

  it('⭐currentMemberType=agent면 서명 플로우 경로도 통째로 안 뜬다(canShowPrimaryAction이 두 분기 공통 게이트)', async () => {
    dashboardContextRef.current = { currentMemberType: 'agent' };
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'high', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-primary-action-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-signature-flow"]')).toBeNull();
  });
});

describe('WorkListDetailPanel — transition 성공/403(평문 경로, risk_grade=low로 고정 — 서명 경로는 위 describe가 전담)', () => {
  it('⭐성공 — 클릭하면 승인 완료 문구가 뜨고 버튼이 사라진다', async () => {
    mockFetchRoutes({
      gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }],
      transitionStatus: 200,
    });
    await mountPanel();
    const btn = container.querySelector('[data-testid="panel-primary-action"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="panel-approved-notice"]')?.textContent).toBe(koMessages.workList.actionApproved);
    expect(container.querySelector('[data-testid="panel-primary-action"]')).toBeNull();
  });

  it('⭐403 — 크래시 없이 「에이전트 계정은 승인할 수 없어요」로 우아하게 처리(깨진 화면 0)', async () => {
    mockFetchRoutes({
      gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }],
      transitionStatus: 403,
    });
    await mountPanel();
    const btn = container.querySelector('[data-testid="panel-primary-action"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('[data-testid="panel-transition-error"]')?.textContent).toBe(koMessages.workList.transitionForbidden);
    // 버튼은 남아 있다(재시도 가능 — 승인완료로 잘못 넘어가지 않는다).
    expect(container.querySelector('[data-testid="panel-primary-action"]')).not.toBeNull();
  });
});

describe('WorkListDetailPanel — 답하기(3860 AC2, BE #4273 착지 前 구조적 읽기 shim)', () => {
  it('gate 응답에 conversation_id가 없으면 비노출(지어내지 않는다)', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task' }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-reply-action"]')).toBeNull();
  });

  it('⭐gate 응답에 conversation_id가 있으면 노출되고 /chats/<id>로 링크한다', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task', conversation_id: 'conv-42' }] });
    await mountPanel();
    const replyLink = container.querySelector('[data-testid="panel-reply-action"]');
    expect(replyLink).not.toBeNull();
    expect(replyLink?.textContent).toBe(koMessages.workList.actionReply);
    expect(replyLink?.getAttribute('href')).toBe('/chats/conv-42');
  });

  it('⭐뮤테이션 표적 — conversation_id가 null이면(값이 있는 필드지만 null) 여전히 비노출', async () => {
    mockFetchRoutes({ gates: [{ id: 'g1', gate_type: 'doc_approval', risk_grade: 'low', status: 'pending', work_item_id: 'task-1', work_item_type: 'task', conversation_id: null }] });
    await mountPanel();
    expect(container.querySelector('[data-testid="panel-reply-action"]')).toBeNull();
  });
});
