// @vitest-environment jsdom
//
// story #2814 — 까디르 QA(PR#3244, HIGH): 순수함수 테스트(gate-evidence.test.ts)만으로는
// `GithubCheckSignal`이 실제로 SHA를 화면에 그리는지 못 잡는다 — `github_check_run_sha`가
// GateResponse 응답 스키마에서 누락돼 있었던 실 버그(FE는 항상 undefined를 받아 배지가
// 영구 누락)를 순수함수 테스트는 아예 건드리지 않았다. 이 파일은 실제 API 응답 shape
// 그대로(github_check_run_id·github_check_run_sha·approved_head_sha 세 필드 전부 포함) 마운트해
// SHA 텍스트가 실제로 DOM에 나타나는지 확인한다. [[feedback-render-test-over-source-grep]] 동형.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { GateEvidence, GateActivityHistory } from './gate-evidence';
import { fetchWithAuth } from '@/lib/db/client';
import type { GateItem } from '@/components/kanban/types';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 까디르 QA(PR#3246, request_changes) — raw fetch는 no-new-raw-fetch 가드(#2687③/#… 401삼킴
// 정리) 위반. GithubRependingReason은 fetchWithAuth(@/lib/db/client)를 쓰므로 여기도 그걸 mock.
// 기본 응답은 빈 배열(원장 없음) — 상단 SHA 배지 describe 블록은 이 훅을 오버라이드하지 않고도
// (ghState==='in_progress'인 케이스에서) GithubRependingReason이 조용히 null을 그리게 한다.
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: () => Promise.resolve([]) }) as Response),
}));

// backend/app/routers/gates.py GateResponse.model_validate(gate) — 실 API가 실제로 내려주는
// 필드 전부(from_attributes 경유, additive/nullable 필드도 값 채워서) 그대로 재현.
function realApiShapedGate(overrides: Partial<GateItem>): GateItem {
  return {
    id: 'gate-1',
    org_id: 'org-1',
    work_item_id: 'wi-1',
    work_item_type: 'story',
    gate_type: 'merge',
    status: 'pending',
    resolver_id: null,
    resolved_at: null,
    resolution_note: null,
    neutral_facts: null,
    created_at: '2026-08-19T00:00:00Z',
    updated_at: '2026-08-19T00:00:00Z',
    github_check_run_id: 987654321,
    github_check_run_sha: 'abc1234567890def1234567890abcdef1234567',
    approved_head_sha: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('GateEvidence — GitHub check 배지 실 응답 shape 마운트(story #2814, 까디르 QA 회귀가드)', () => {
  it('github_check_run_sha가 실 API 응답처럼 채워져 있으면 짧은 SHA(7자)가 실제로 DOM에 나타난다', async () => {
    const gate = realApiShapedGate({ status: 'pending' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // status='pending'은 ghState==='in_progress'라 GithubRependingReason도 같이 마운트된다
    // (기본 mock=빈 배열) — 그 비동기 fetch까지 act로 감싸 flush(2단 도입 후 회귀 방지).
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    // 짧은 SHA(git 관례 7자) — 전체 40자 SHA가 아니라 잘린 값이 실제로 보여야 한다.
    expect(container.textContent).toContain('abc1234');
    expect(container.textContent).not.toContain('abc1234567890def1234567890abcdef1234567');
  });

  it('github_check_run_sha가 undefined(구버전 응답 재현)면 SHA 자리를 안 그린다 — 크래시 없이 정직 생략', async () => {
    const gate = realApiShapedGate({ status: 'pending', github_check_run_sha: undefined });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    // check 상태 자체는 github_check_run_id만으로도 뜬다(githubCheckState는 sha 불필요) —
    // SHA 텍스트만 없어야 한다.
    expect(container.textContent).toContain('GitHub check');
    expect(container.textContent).not.toMatch(/SHA [0-9a-f]{7}/);
  });
});

// story #2814 2단(§5-② 그라운딩) — GithubRependingReason은 useEffect+fetch로 원장을 지연
// 로드한다. 순수함수 테스트로는 이 비동기 배선(호출 URL·최신 이벤트 필터링·실패 침묵)을
// 전혀 못 잡는다는 게 정확히 까디르 QA(PR#3244)가 증명한 클래스라 처음부터 마운트+fetch mock로
// 검증한다.
describe('GateEvidence — 재-pending 사유(원장 지연 로드, story #2814 2단)', () => {
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('최신 원장 이벤트가 re_pending이면 새 SHA를 포함한 사유 문구가 실제로 DOM에 나타난다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-2', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'def9876543210abc9876543210def9876543210', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-19T02:00:00Z' },
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchWithAuth).toHaveBeenCalledWith('/api/gates/gate-1/github-check-events');
    expect(container.textContent).toContain('def9876');
  });

  // 2026-08-20 dev 라이브 AC2 재검 중 실측(gate bad5ad2c, PR#3249) — 새 커밋 감지 시 BE가
  // re_pending 기록 직후 그 SHA로 published까지 같은 처리 안에서 남겨, 원장 최신순 정렬 시
  // events[0]이 published·re_pending이 events[1]이 되는 순서가 실운영 기본값이었다. 이 케이스에서
  // events[0]만 보던 구버전은 사유 문구가 항상 죽어있었다(AC2 미충족) — 회귀 가드.
  it('원장 최신 이벤트가 published여도 그 직전이 re_pending이면 사유 문구가 나타난다(실측 순서)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-2', repo_full_name: 'moonklabs/sprintable', pr_number: 3249, head_sha: 'b01c8c3d7fdf291090e3c3e4b69a0c8d3ab03981', event_type: 'published', check_conclusion: null, created_at: '2026-08-20T02:56:36.175894Z' },
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3249, head_sha: 'b01c8c3d7fdf291090e3c3e4b69a0c8d3ab03981', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-20T02:56:36.114101Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('b01c8c3');
  });

  it('최신 원장 이벤트가 re_pending이 아니면(published 등) 사유 문구를 그리지 않는다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'abc1234567890def1234567890abcdef1234567', event_type: 'published', check_conclusion: null, created_at: '2026-08-19T01:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain('재-pending');
  });

  // story #2840(BE PR#3264 §2819 착지) — prior_sha가 채워진 re_pending 행은 "SHA A→B 무효화"
  // 완전 문구로 조립된다(AC1).
  it('re_pending 행에 prior_sha가 있으면 두 SHA 모두 담긴 완전 문구가 뜬다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3264, head_sha: 'def9876543210abc9876543210def9876543210', prior_sha: 'aaa1111111111111111111111111111111111a', event_type: 're_pending', check_conclusion: null, created_at: '2026-08-20T02:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('aaa1111');
    expect(container.textContent).toContain('def9876');
  });

  // story #2840 AC2 — prior_sha가 null(마이그레이션 이전 행·published/resolved 행)이면 두 SHA를
  // 지어내지 않고 기존 단축 문구("새 SHA만")로 정직하게 폴백한다(no-fiction).
  it('re_pending 행에 prior_sha가 null이면 prior SHA를 지어내지 않고 단축 문구로 폴백한다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'evt-1', repo_full_name: 'moonklabs/sprintable', pr_number: 3244, head_sha: 'def9876543210abc9876543210def9876543210', prior_sha: null, event_type: 're_pending', check_conclusion: null, created_at: '2026-08-19T02:00:00Z' },
      ]),
    } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('def9876');
    expect(container.textContent).not.toContain('에서 SHA');
  });

  it('원장 조회가 실패해도(네트워크/404) 카드는 붕괴하지 않고 GithubCheckSignal은 그대로 보인다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 500 } as Response);

    const gate = realApiShapedGate({ status: 'pending', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('GitHub check');
    expect(container.textContent).not.toContain('재-pending');
  });

  it('success/failure 등 재-pending 여지 없는 상태는 원장 조회 자체를 하지 않는다(불필요 왕복 방지)', async () => {
    const gate = realApiShapedGate({ status: 'approved', github_check_run_id: 987654321 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

// story #2862(loop-closure P2-B FE, BE PR#3277) — hypothesis_outcome_confirm 게이트의
// neutral_facts.draft_target/draft_actual/draft_reason 렌더.
describe('GateEvidence — 측정 판정 초안 렌더(story #2862)', () => {
  function draftGate(overrides: Partial<GateItem> = {}, neutralFacts: Record<string, unknown> = {}): GateItem {
    return realApiShapedGate({
      gate_type: 'hypothesis_outcome_confirm',
      work_item_type: 'hypothesis',
      status: 'pending',
      github_check_run_id: null,
      neutral_facts: { draft_target: 'verified', draft_actual: 42, draft_reason: '목표치 초과 달성', ...neutralFacts },
      ...overrides,
    });
  }

  it('draft_target/draft_actual/draft_reason이 실제로 DOM에 나타난다(AC1)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={draftGate()} />)); });

    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftBadge);
    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftTargetVerified);
    expect(container.textContent).toContain('42');
    expect(container.textContent).toContain('목표치 초과 달성');
  });

  // AC1/AC2 — 초안은 destructive/success가 아니라 info 톤 하나로만 표현한다(맞음이든 틀림이든
  // 확정처럼 보이면 안 된다).
  it('destructive/success 색을 쓰지 않고 info 톤만 쓴다(AC1/AC2 — verified/falsified 무관)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_target: 'falsified' })} />));
    });

    expect(container.innerHTML).not.toMatch(/bg-destructive|text-destructive/);
    expect(container.innerHTML).not.toMatch(/bg-success|text-success/);
    expect(container.querySelector('.bg-info\\/10')).toBeTruthy();
  });

  it('draft_reason이 없으면 근거 없음을 정직하게 알린다(AC3 — 지어내지 않음)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_reason: null })} />));
    });

    expect(container.textContent).toContain(koMessages.cage.hypothesisDraftReasonMissing);
  });

  it('draft_target이 계약 밖 값이면(BE 위반 방어) 초안 블록을 그리지 않는다(no-fiction)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<GateEvidence gate={draftGate({}, { draft_target: 'unknown_target' })} />));
    });

    expect(container.textContent).not.toContain(koMessages.cage.hypothesisDraftBadge);
  });
});

// story #3328(3바퀴 라이브 결함 · db967a77) — 레시피 approve 게이트(external_publish)의 실
// neutral_facts(BE recipe_gate_hooks.py::_build_approval_neutral_facts 산출물 그대로) 마운트.
// 실사고: 게이트 09631e56은 이 필드들이 전부 채워져 있었는데도 dialog가 «근거 데이터 없음»을
// 그렸다 — 순수함수 테스트(gateHasEvidence)만으론 참조 토큰이 실제로 클릭 가능한 칩으로
// 그려지는지 못 잡으므로(entity-ref.ts 파싱+EntityChip 마운트 자체가 검증 대상) 여기서 실제
// DOM 마운트로 검증한다.
describe('GateEvidence — 레시피 approve 게이트 승인 대상 실물 렌더(story #3328)', () => {
  function recipeApprovalGate(neutralFacts: Record<string, unknown>): GateItem {
    return realApiShapedGate({
      gate_type: 'external_publish', work_item_type: 'story', status: 'pending',
      github_check_run_id: null, neutral_facts: neutralFacts,
    });
  }

  it('⭐AC1 핵심 — work item·draft doc 참조 토큰이 클릭 가능한 칩으로, channel·stage가 텍스트로 실제 DOM에 나타난다(«근거 데이터 없음» 소멸)', async () => {
    const gate = recipeApprovalGate({
      work_item_title: '9월 캠페인', work_item_reference_token: '[9월 캠페인](entity:story:11111111-1111-1111-1111-111111111111)',
      channel: 'threads', draft_doc_reference_token: '[캠페인 초안 v1](entity:doc:22222222-2222-2222-2222-222222222222)',
      draft_doc_summary: '이번 캠페인은 신규 유저 확보에 초점을 맞춘다.', stage: 'approve',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain(koMessages.cage.evidenceNonePrompt);
    expect(container.textContent).toContain('9월 캠페인');
    expect(container.textContent).toContain('캠페인 초안 v1');
    expect(container.textContent).toContain('threads');
    expect(container.textContent).toContain('approve');
    // EntityChip이 실제로 클릭 가능한 요소(role=button, entity-ref.ts 파싱 성공의 증거)로 그려졌는지.
    expect(container.querySelectorAll('[role="button"], a, button').length).toBeGreaterThan(0);
  });

  // PO 변경요청①(2026-09-02, PR#3710 리뷰) — BE `_escape_title`(reference_token.py)이 라벨 안
  // `\ [ ] ( )`를 백슬래시-escape한다. 초기 구현이 escape 없는 픽스처로만 테스트해 못 잡았던
  // 자리 — 실 게이트 09631e56 제목(팀 스토리 제목 관례 "[3바퀴·draft] ... v2(276/500자·반려
  // 반영)")을 그대로 재현해, 칩 텍스트가 백슬래시 없이 원문 그대로 보이는지 검증한다.
  it('⭐PO 변경요청① — 라벨 안 대괄호/괄호가 BE escape(\\[ \\] \\()된 실 제목도 백슬래시 없이 원문 그대로 렌더된다', async () => {
    const gate = recipeApprovalGate({
      draft_doc_reference_token:
        '[\\[3바퀴·draft\\] 산출물 v2\\(276/500자·반려 반영\\)](entity:doc:33333333-3333-3333-3333-333333333333)',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('[3바퀴·draft] 산출물 v2(276/500자·반려 반영)');
    expect(container.textContent).not.toContain('\\[3바퀴');
    expect(container.textContent).not.toContain('v2\\(');
  });

  // PO 변경요청②(2026-09-02, PR#3710 리뷰) — story #2420 규칙: bg-muted/40 tint 위에서 값
  // (stage·channel)은 라벨과 같은 muted 톤에 묻히지 않고 text-foreground여야 한다.
  it('⭐PO 변경요청② — stage·channel 값은 text-foreground, 라벨만 text-muted-foreground(값이 묻히지 않음)', async () => {
    const gate = recipeApprovalGate({ stage: 'approve', channel: 'threads' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    const stageValue = Array.from(container.querySelectorAll('.text-foreground'))
      .find((el) => el.textContent === 'approve');
    const channelValue = Array.from(container.querySelectorAll('.text-foreground'))
      .find((el) => el.textContent === 'threads');
    expect(stageValue).toBeTruthy();
    expect(channelValue).toBeTruthy();
  });

  it('AC1 — draft_doc_summary는 기본 접힘, 펼치기 클릭 후에만 본문이 DOM에 나타난다', async () => {
    const gate = recipeApprovalGate({
      channel: 'threads', draft_doc_summary: '펼쳐야 보이는 본문 텍스트',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain('펼쳐야 보이는 본문 텍스트');
    const toggle = container.querySelector('button');
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('펼쳐야 보이는 본문 텍스트');
  });

  it('AC2 — neutral_facts가 전부 BE sentinel(«미확認»)이면 여전히 «근거 데이터 없음»(진짜 빈 카드는 지어내지 않는다)', async () => {
    const gate = recipeApprovalGate({
      work_item_title: '미확認', work_item_reference_token: '미확認', channel: '미확認',
      draft_doc_reference_token: '미확認', draft_doc_summary: '미확認',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain(koMessages.cage.evidenceNonePrompt);
  });

  // AC4 — 머지 게이트(neutral_facts에 ci_result/trust만 있는 기존 shape)는 이 신규 분기가
  // 안 걸려 회귀 0이어야 한다(레시피 전용 신규 키를 찾다가 기존 렌더를 흔들면 안 됨).
  it('AC4 회귀 0 — 머지 게이트(ci_result/trust)는 레시피 블록이 안 뜨고 기존 렌더 그대로', async () => {
    const gate = realApiShapedGate({
      gate_type: 'merge', status: 'pending', github_check_run_id: null,
      neutral_facts: { ci_result: 'pass', trust: 0.9 },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain(koMessages.cage.ciPass);
    expect(container.textContent).not.toContain(koMessages.cage.recipeApprovalDraftLabel);
  });

  // story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §4-3③·§6-3) —
  // 글 관리 승인 요청(S2 봉인 착지 後)이 채우는 content_body/content_version/content_sha256.
  // draft_doc_summary(300자 절단, 접힘 기본)와 달리 이쪽은 "전문"이라 접힘 없이 항상 보인다.
  it('⭐S4 §6-3 — content_body는 접힘 없이 항상 전문이 보이고, 버전·봉인 해시 앞 12자가 나란히 뜬다', async () => {
    const gate = recipeApprovalGate({
      channel: 'hosted_site', stage: 'approve',
      content_body: '펼치지 않아도 항상 보이는 전문 본문입니다.',
      content_version: 2,
      content_sha256: 'abcdef0123456789fedcba9876543210',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    // 접힘 버튼 클릭 없이 바로 텍스트가 보인다(draft_doc_summary와의 핵심 차이).
    expect(container.textContent).toContain('펼치지 않아도 항상 보이는 전문 본문입니다.');
    expect(container.textContent).toContain('v2');
    expect(container.textContent).toContain('abcdef012345'); // 앞 12자만(전체 해시를 카드에 그대로 늘어놓지 않음)
    expect(container.textContent).not.toContain('abcdef0123456789fedcba9876543210'); // 전체 해시는 아님
  });

  it('content_body가 없으면(S2 미착지 — 지금 실제 상태) 버전·해시 줄 자체가 안 뜬다(지어내지 않음)', async () => {
    const gate = recipeApprovalGate({ channel: 'hosted_site', stage: 'approve' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).not.toContain(koMessages.cage.recipeApprovalVersionLabel);
    expect(container.textContent).not.toContain(koMessages.cage.recipeApprovalSealedHashLabel);
  });

  it('AC4 회귀 0 재확認 — content_version=0(falsy이지만 유효한 버전 번호)도 정확히 렌더된다', async () => {
    const gate = recipeApprovalGate({ channel: 'hosted_site', content_version: 0, content_sha256: 'h' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateEvidence gate={gate} />)); });

    expect(container.textContent).toContain('v0'); // !== null 체크라 0도 통과해야 함(falsy 트랩 회귀 방지)
  });
});

// story #2975 AC4(PO 확定 2026-08-24) — 결재 이력(GET /gates/{id}/activity) 실 응답 shape
// 마운트. gates.py GateActivityItem과 정합(id/action/actor_id/actor_name/context/created_at).
describe('GateActivityHistory — 결재 이력 실 응답 shape 마운트(story #2975 AC4)', () => {
  afterEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it('승인+취소 두 건이 actor_name·action 라벨·SHA와 함께 그려진다(미스터리①②의 UI판)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        {
          id: 'log-2', action: 'gate_resolution_undone', actor_id: 'm-1', actor_name: 'po@test.com',
          context: { previous_status: 'approved', previous_approved_head_sha: 'sha-a1b2c3d4e5' },
          created_at: '2026-08-23T19:05:00Z',
        },
        {
          id: 'log-1', action: 'gate_approved', actor_id: 'm-1', actor_name: 'po@test.com',
          context: { head_sha: 'sha-a1b2c3d4e5' }, created_at: '2026-08-23T18:57:00Z',
        },
      ]),
    } as Response);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateActivityHistory gateId="gate-1" />)); });

    expect(fetchWithAuth).toHaveBeenCalledWith('/api/gates/gate-1/activity');
    expect(container.textContent).toContain('po@test.com');
    expect(container.textContent).toContain(koMessages.cage.gateActivityActionApproved);
    expect(container.textContent).toContain(koMessages.cage.gateActivityActionUndone);
    expect(container.textContent).toContain('sha-a1b'); // SHA 짧은형(7자) 표시.
  });

  it('actor_name이 없으면(orphan) 정직한 폴백 문구를 보여준다(actor_id로 지어내지 않음)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 'log-1', action: 'gate_voided', actor_id: 'm-gone', actor_name: null, context: { reason: 'x' }, created_at: '2026-08-23T00:00:00Z' },
      ]),
    } as Response);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateActivityHistory gateId="gate-1" />)); });

    expect(container.textContent).toContain(koMessages.cage.gateActivityActorFallback);
    expect(container.textContent).toContain(koMessages.cage.gateActivityActionVoided);
  });

  it('빈 이력은 "이력 없음"을 정직하게 보여준다(로드 실패와 구분)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: () => Promise.resolve([]) } as Response);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateActivityHistory gateId="gate-1" />)); });

    expect(container.textContent).toContain(koMessages.cage.gateActivityEmpty);
  });

  it('조회 실패는 조용히(카드 붕괴 없이) 아무것도 안 그린다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 500 } as Response);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(wrap(<GateActivityHistory gateId="gate-1" />)); });

    expect(container.textContent).not.toContain(koMessages.cage.gateActivityHistoryTitle);
  });
});
