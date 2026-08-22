// @vitest-environment jsdom
//
// story #2354 회귀 가드 — StoryDetailPanel의 새 `overlayPosition` prop이 (a) 기존 칸반
// 전체화면 드로어를 무변화로 유지하고(회귀 0, AC9) (b) 값을 주면 지도 위에 겹치는 소형
// 팝오버로 바뀌는지(배경 딤 없음·top/height 인라인 스타일 적용) 왕복 검증한다. 내부
// 콘텐츠(작업목록·댓글 등)의 정확성은 kanban-board.test.tsx가 이미 통합 경로로 커버하므로,
// 여기서는 이 PR이 건드린 «바깥 래퍼»만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { bumpOrgSyncVersion } from '@/lib/project-context-client';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

// kanban-board.test.tsx와 같은 관례 — 이 컴포넌트가 내부에서 부르는 나머지 fetch들
// (comments/activities/dependencies/hypotheses/gates 등)는 그레이스풀 폴백 경로만 타면
// 되므로 실패 응답으로 충분하다.
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
}

beforeEach(() => {
  stubFetch();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('StoryDetailPanel — overlayPosition (story #2354, 지도 위에 겹치는 팝오버)', () => {
  it('without overlayPosition: renders the existing full-screen drawer with a dimmed backdrop (칸반 회귀 0, AC9)', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const [backdrop, panel] = Array.from(container.querySelectorAll('[aria-hidden="true"], [role="dialog"]'));
    expect(backdrop?.className).toContain('bg-overlay-backdrop');
    expect(panel?.className).toContain('inset-0');
    expect(panel?.className).toContain('lg:right-0');
    expect((panel as HTMLElement)?.style.top).toBe('');
  });

  it('with overlayPosition: no dimmed backdrop, and the panel uses the given top/height instead of the full drawer classes (지도를 가리지 않는다)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 120, heightPx: 300 }} />,
      ));
    });
    const backdrop = container.querySelector('[aria-hidden="true"]');
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(backdrop?.className).not.toContain('bg-overlay-backdrop');
    expect(backdrop?.className).not.toContain('backdrop-blur-sm');
    expect(panel.className).not.toContain('inset-0');
    expect(panel.className).not.toContain('lg:right-0');
    expect(panel.style.top).toBe('120px');
    expect(panel.style.height).toBe('300px');
  });

  it('overlay panel content is the SAME component internals — story title still renders (재사용 확認, AC7)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory({ title: '겹침 패널 시험용 스토리' })} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    expect(container.textContent).toContain('겹침 패널 시험용 스토리');
  });
});

// story #2528 — 전역 스크롤바 숨김(#2165) 하에 상세패널 본문 스크롤 컨테이너가 예외 목록에
// 없어 스크롤바가 안 보이던 결함. globals.css 범용 옵트인 `.scrollbar-visible` 클래스 적용
// 계약을 고정한다. jsdom은 실 스크롤바 렌더를 계산하지 않으므로 실제 가시성은 라이브 QA 몫
// (스토리 AC의 "라이브 픽셀 양성대조"가 결정적 게이트).
describe('StoryDetailPanel — #2528 본문 스크롤바 가시성', () => {
  it('본문 overflow-y-auto 컨테이너에 scrollbar-visible 클래스가 적용된다', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body).toBeTruthy();
    expect(body?.className).toContain('scrollbar-visible');
  });

  it('겹침 팝오버 모드에서도 본문 스크롤 컨테이너의 클래스는 회귀 없이 유지된다', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body?.className).toContain('scrollbar-visible');
  });
});

// story #2593(#2545 후속) — kanban `?story=` 딥링크로 이 패널이 콜드 하드네비 직후 열리면
// comments/activities/labels/references/dependencies/gates 6개 auto-mount fetch effect가
// switch-org 완료 前에 구 org_id로 먼저 발사될 수 있다. #2946과 동형 stale-guard(orgSyncVersion
// deps + cancelled 플래그)를 얹었는지를, "org-switch 신호 → 재요청 → 늦게 도착한 구 응답이
// 새 응답을 덮지 않는다"는 실제 레이스로 검증한다(대표로 comments effect 사용).
describe('StoryDetailPanel — org-switch 잔여 레이스 stale-guard (story #2593, #2545 후속)', () => {
  it('org-switch 재요청 이후 늦게 도착한 구 org 응답이 새 org 응답을 덮지 않는다', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    let resolveSecond: ((v: unknown) => void) | undefined;
    let commentsCallCount = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/comments?limit=20')) {
        commentsCallCount += 1;
        if (commentsCallCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return new Promise((resolve) => { resolveSecond = resolve; });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    expect(commentsCallCount).toBe(1); // 최초 마운트 — 구 org 요청(1st) 발사

    // DashboardShell의 switch-org 성공 신호 — orgSyncVersion 구독 effect가 재요청되어야 한다.
    await act(async () => { bumpOrgSyncVersion(); });
    expect(commentsCallCount).toBe(2); // 신 org 요청(2nd) 발사 확인 — 재요청 자체가 안 되면 여기서 실패(구코드 회귀)

    // 신 org 응답(2nd)이 먼저 도착
    await act(async () => {
      resolveSecond?.({ ok: true, json: async () => ({ data: [{ id: 'fresh', content: 'FRESH_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    const trigger = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Comments'));
    expect(trigger()?.textContent).toBe('Comments (1)');

    // 구 org 응답(1st)이 뒤늦게 도착 — cancelled라 무시돼야 fresh 상태가 안 덮인다.
    await act(async () => {
      resolveFirst?.({ ok: true, json: async () => ({ data: [{ id: 'stale', content: 'STALE_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    expect(trigger()?.textContent).toBe('Comments (1)'); // 여전히 1 — stale 응답이 2번째로 덮어쓰지 않았다
  });
});

// story #2922 W1 — 카디르군 QA(#3336 MEDIUM) 지적 회귀가드: Workcell 헤더 pipelineStage
// 파생이 needs_input/verified 둘 다 localStatus 무관 단독판정이어야 한다. verified만
// `localStatus==='in-review'`로 게이팅됐던 결함 때문에 in-progress+webhook발 merge
// 게이트(ci_result=pass)가 running으로 오표시됐다 — 이 async 왕복이 그 정확한 경로를 판다.
describe('StoryDetailPanel — Workcell pipelineStage 파생(story #2922, 카디르군 #3336 MEDIUM 회귀가드)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountWithGates(status: string, gates: Array<{ gate_type: string; status: string; neutral_facts?: Record<string, unknown> }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/gates?work_item_id=')) {
        return { ok: true, json: async () => gates };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status, assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID] })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  // 스테퍼가 6라벨을 항상 전부 렌더하므로(현재단계=스타일만 다름) textContent.toContain으로는
  // "어느 단계가 current인지" 못 잰다 — aria-current="step"이 붙은 그 원소의 텍스트로만 확인.
  function currentStageLabel(): string | null {
    return container.querySelector('[aria-current="step"]')?.textContent?.trim() ?? null;
  }

  it('in-progress + merge 게이트 pending(ci_result=pass) → Verified (수정 전엔 Running으로 오표시됨)', async () => {
    await mountWithGates('in-progress', [{ gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } }]);
    expect(currentStageLabel()).toBe('Verified');
  });

  it('in-progress + needs-input류 게이트 pending(doc_approval) → Needs input (기존에도 정상, 대칭 확인)', async () => {
    await mountWithGates('in-progress', [{ gate_type: 'doc_approval', status: 'pending' }]);
    expect(currentStageLabel()).toBe('Needs input');
  });
});

// story #2922 W2 — Evidence 구획 = ProofCapsule density="full" 실배선. glance-hero.tsx의
// buildEvidence/buildTrustSeal와 동일 no-fiction 규율(신호 없는 필드는 렌더 안 함)을 판다.
describe('StoryDetailPanel — Workcell Evidence 구획 실배선(story #2922 W2)', () => {
  const HUMAN_ID = 'human-1';
  const memberMap = { [HUMAN_ID]: { id: HUMAN_ID, name: '책임자', type: 'human' } };

  async function mountEvidence(storyOverrides: Record<string, unknown>, gates: Array<Record<string, unknown>>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/gates?work_item_id=')) {
        return { ok: true, json: async () => gates };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel
          story={makeStory({ status: 'in-review', assignee_id: HUMAN_ID, assignee_ids: [HUMAN_ID], ...storyOverrides })}
          tasks={[]} onClose={() => {}} memberMap={memberMap}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('pending merge 게이트(risk_grade=high) → 게이트 액션 버튼이 그 게이트로 링크된다', async () => {
    await mountEvidence({}, [{ id: 'gate-1', gate_type: 'merge', status: 'pending', risk_grade: 'high', neutral_facts: {} }]);
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/gates/gate-1');
    expect(link).toBeTruthy();
    expect(link?.textContent).toContain('Merge gate');
  });

  it('merge 게이트가 이미 resolved면 게이트 버튼을 다시 안 띄운다(no-fiction — 끝난 결정을 대기 중처럼 보이면 안 됨)', async () => {
    await mountEvidence({ human_verified: true, human_verified_by: HUMAN_ID, human_verified_at: '2026-08-20T00:00:00Z' }, [
      { id: 'gate-1', gate_type: 'merge', status: 'approved', risk_grade: 'high', neutral_facts: {} },
    ]);
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/gates/gate-1');
    expect(link).toBeFalsy();
  });

  it('human_verified → TrustSeal이 검증자 실명으로 렌더된다(주장이 아니라 검증)', async () => {
    await mountEvidence({ human_verified: true, human_verified_by: HUMAN_ID, human_verified_at: '2026-08-20T00:00:00Z' }, [
      { id: 'gate-1', gate_type: 'merge', status: 'approved', neutral_facts: {} },
    ]);
    expect(container.textContent).toContain('책임자');
  });

  it('merge 게이트 neutral_facts.ci_result=pass → Evidence autoVerify passed 신호가 렌더된다', async () => {
    await mountEvidence({ self_reported: true }, [{ id: 'gate-1', gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } }]);
    // ProofCapsule FullVariant의 evidence.autoVerify==='passed' 렌더 텍스트(proofCapsule.evidence.autoPassed).
    expect(container.textContent).toMatch(/자동|검증|passed/i);
  });

  it('신호가 하나도 없으면(게이트 0·self_reported/human_verified 둘 다 false) 정직한 빈 상태 그대로다', async () => {
    await mountEvidence({}, []);
    expect(container.textContent).toContain('아직 증거 없음');
  });
});
