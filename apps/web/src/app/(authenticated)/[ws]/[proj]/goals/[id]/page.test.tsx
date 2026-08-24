// @vitest-environment jsdom
//
// story #2545(카디르 라이브 재QA 5단계, PO blocking 리뷰 2026-08-12) — goals/[id]/page.tsx는
// orgSyncVersion 의존성만으론 원천적으로 못 선다:
// ①레이스에서 지는 쪽이 기본 — React가 자식 effect를 부모(DashboardShell의 switch-org)보다
//   먼저 실행하므로 이 GET의 403이 대개 switch-org보다 먼저 돌아오고, catch가 즉시
//   router.replace(목록)를 발화 → 컴포넌트 언마운트 → orgSyncVersion 재요청이 설 자리 자체가
//   사라진다.
// ②레이스에서 이겨도 진다 — stale-guard(cancelled 플래그) 없이 bump로 effect가 재실행돼 2차
//   요청이 성공해도, 뒤늦게 resolve된 1차 in-flight 403의 catch가 그대로 replace를 발화한다.
// 처방: 403(org-scope 불일치 中일 수 있음)은 replace 금지(로딩 유지·orgSyncVersion 재요청에
// 맡김) — 진짜 없음(404 등)만 목록으로. + cancelled 플래그로 재실행 시 이전 체인 무효화.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

// 실 Next.js useRouter()는 렌더마다 참조가 안정적이다(memoized) — 매번 새 객체를 반환하는
// 모크는 그 자체가 페이지의 fetch effect(deps에 router 포함) 재실행을 매 렌더 유발해
// «성공→setEpic→재렌더→router 참조변경→effect 재실행→재fetch→재렌더…» 무한루프를 만든다
// (실 버그 아님 — 순전히 이 모크의 인공물). vi.hoisted로 고정 참조를 만들어 방지.
const { replaceMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  const pushMock = vi.fn();
  return { replaceMock, routerMock: { replace: replaceMock, push: pushMock } };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'epic-1' }),
  useRouter: () => routerMock,
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// 이 페이지 자신의 fetch/effect/403/stale-guard 로직만 격리해서 잰다 — 자식들의 자체 fetch는
// 별도 관심사(hypotheses-section/entity-dispatch-panel 자신의 org-sync는 story #2545에서
// 각각 이미 orgSyncVersion을 얹었다).
vi.mock('@/components/dispatch/entity-dispatch-panel', () => ({
  EntityDispatchPanel: () => <div data-testid="dispatch-panel-stub" />,
}));
vi.mock('@/components/hypotheses/hypotheses-section', () => ({
  HypothesesSection: () => <div data-testid="hypotheses-section-stub" />,
}));

// story #2587 AC3 — orgSyncPending을 테스트별로 바꿔 잰다. 기본(false)은 "org-sync가 이
// 경로에 대해 할 일이 없다" — DashboardShell 실 컨텍스트의 디폴트 값(orgSyncPending: false)과
// 동형(Provider 없이 렌더될 때의 실제 상태). 명시적으로 true로 바꾼 테스트만 org-mismatch
// pending 시나리오를 잰다.
let mockOrgSyncPending = false;
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ orgSyncPending: mockOrgSyncPending }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(
  GoalsRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; orgId: string; children: React.ReactNode }>,
  node: React.ReactNode,
) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <GoalsRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1" orgId="org-1">
        {node}
      </GoalsRouteProvider>
    </NextIntlClientProvider>
  );
}

function epicFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'epic-1', title: '목표 제목', description: '', status: 'active', priority: 'medium',
    project_id: 'proj-1', assignee_id: null, target_story_points: null, target_date: null,
    stories: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  replaceMock.mockReset();
  mockOrgSyncPending = false;
});

async function mount(fetchImpl: (...args: unknown[]) => Promise<unknown>) {
  vi.stubGlobal('fetch', fetchImpl);
  const { default: EpicDetailPage } = await import('./page');
  const { GoalsRouteProvider } = await import('../goals-context');
  await act(async () => { root.render(wrap(GoalsRouteProvider, <EpicDetailPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return { EpicDetailPage, GoalsRouteProvider };
}

// story f401139e — BE GET /api/goals/{id}는 X-Project-Id와 무관하게 200을 줄 수 있다(그라운딩
// 확認). 프로젝트 전환 직후 이 페이지가 옛 프로젝트 goal을 편집/삭제 버튼까지 활성 상태로 그대로
// 보여주던 결함을 잡는다 — res.ok=200이어도 응답의 project_id가 현재 프로젝트(wrap()의
// projectId="proj-1")와 다르면 목록으로 replace하고 절대 렌더하지 않는다.
describe('EpicDetailPage — cross-project stale 응답 폴백 (story f401139e)', () => {
  it('200이어도 응답 project_id가 현재 프로젝트와 다르면 렌더하지 않고 목록으로 replace한다', async () => {
    await mount(vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: epicFixture({ project_id: 'other-project', title: '남의 프로젝트 목표' }) }),
    })));
    expect(replaceMock).toHaveBeenCalledWith('/ws/proj/goals');
    expect(container.textContent).not.toContain('남의 프로젝트 목표');
  });

  it('200이고 project_id가 현재 프로젝트와 같으면 정상 렌더한다(회귀 없음)', async () => {
    await mount(vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: epicFixture({ project_id: 'proj-1', title: '내 프로젝트 목표' }) }),
    })));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('내 프로젝트 목표');
  });
});

describe('EpicDetailPage — 403 vs 404 분리 (story #2545)', () => {
  it('org-sync 성립 여지가 있는(mismatch pending) 403이면 replace 없이 로딩 상태를 유지한다(#2545 원 시나리오)', async () => {
    // story #2587 AC3 — 이 테스트의 진짜 의도는 "org-sync가 아직 이 403을 되돌릴 수 있을
    // 때"였다(#2545 PO 블로킹 리뷰). 그 조건을 명시(orgSyncPending=true)해야 원 의도 그대로다.
    mockOrgSyncPending = true;
    await mount(vi.fn(async () => ({ ok: false, status: 403, json: async () => null })));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.goals.loading);
  });

  it('404(진짜 없음)면 목록으로 replace한다', async () => {
    await mount(vi.fn(async () => ({ ok: false, status: 404, json: async () => null })));
    expect(replaceMock).toHaveBeenCalledWith('/ws/proj/goals');
  });

  it('성공하면 목표 화면이 렌더되고 replace는 0회다', async () => {
    await mount(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: epicFixture() }) })));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('목표 제목');
  });

  // story #2974(PR-D0 delta, 유나 확定 2026-08-23) — 이 두 숫자(진행률/outcome)는 doc상
  // Display 대상이 아니다(font-display 미부착). 대신 무게 유틸(font-editorial-heading,
  // --font-weight-editorial-heading:820)만 유지 — D0 초판(font-display 단독 치환)이 이
  // 무게를 조용히 지웠던 회귀를 여기서 고정한다.
  it('진행률·outcome 숫자는 font-display가 아니라 font-editorial-heading(무게 820)만 경유한다(#2974 D0 delta)', async () => {
    await mount(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: epicFixture() }) })));
    const weightEls = [...container.querySelectorAll('.font-editorial-heading')];
    expect(weightEls.length).toBeGreaterThanOrEqual(2);
    expect(weightEls.every((el) => !el.classList.contains('font-display'))).toBe(true);
  });
});

// story #2587 AC3·AC4 — org-sync가 이 경로에 대해 아무 것도 할 게 없는(orgSyncPending=false,
// 이 스위트의 기본값) 403은 이제 영구 스피너가 아니라 정직한 「권한 없음」으로 끝난다.
describe('EpicDetailPage — 진짜 권한없음 403 정직 종결 (story #2587 AC3)', () => {
  it('orgSyncPending=false(org-sync가 이 경로에 대해 할 일이 없음)이면 403은 진짜 — 로딩이 안 걸리고 「권한 없음」+목록 링크를 정직하게 보인다', async () => {
    mockOrgSyncPending = false;
    await mount(vi.fn(async () => ({ ok: false, status: 403, json: async () => null })));
    // 영구 로딩이 아니다 — loading 문구가 안 뜬다(빠져나왔다).
    expect(container.textContent).not.toContain(koMessages.goals.loading);
    // 자동으로 목록에 튕겨내지도 않는다(오판 네비게이션 금지, #2545와 같은 원칙).
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.goals.forbiddenTitle);
    expect(container.textContent).toContain(koMessages.goals.forbiddenDescription);
    const backLink = [...container.querySelectorAll('a')].find((a) => a.textContent === koMessages.goals.backToList) as HTMLAnchorElement;
    expect(backLink).toBeDefined();
    expect(backLink.getAttribute('href')).toBe('/ws/proj/goals');
  });

  it('orgSyncPending=true였다가 재요청도 여전히 403이면(진짜 org 불일치 아닌 순수 무권한) 재요청 후 정직 종결로 전이한다', async () => {
    // 시나리오: 처음엔 org-sync가 아직 안 끝나 orgSyncPending=true로 mount(로딩 유지) →
    // sync가 끝나며 orgSyncPending이 false로 바뀌고 bump가 재요청을 트리거 → 그 재요청도
    // 403이면(다른 org 소유 epic처럼 진짜 무권한) 이번엔 정직 종결이어야 한다.
    mockOrgSyncPending = true;
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => null }));
    vi.stubGlobal('fetch', fetchImpl);
    const { default: EpicDetailPage } = await import('./page');
    const { GoalsRouteProvider } = await import('../goals-context');
    await act(async () => {
      root.render(wrap(GoalsRouteProvider, <EpicDetailPage />));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).toContain(koMessages.goals.loading);

    mockOrgSyncPending = false;
    const { bumpOrgSyncVersion } = await import('@/lib/project-context-client');
    await act(async () => {
      bumpOrgSyncVersion();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.textContent).not.toContain(koMessages.goals.loading);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(koMessages.goals.forbiddenTitle);
  });
});

describe('EpicDetailPage — org-sync stale-guard (story #2545)', () => {
  it('1차 403(in-flight) 中 bump로 2차 요청이 시작되고, 뒤늦게 resolve된 1차 403은 무시된다(replace 0회·화면 복구)', async () => {
    let calls = 0;
    let resolveFirst!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    const firstPending = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => {
      resolveFirst = resolve;
    });

    // story #2958 — GoalTrustRail이 이 페이지에 /api/hypotheses 호출을 하나 더 추가했다(§6, 기존
    // 엔드포인트 재사용). 이 테스트가 감시하는 건 오직 /api/goals/{id} 왕복의 race이므로, 그
    // 호출만 계수한다(가짜로 3번째를 만들지 않기 위해 URL로 분기).
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === 'string' && !url.includes('/api/goals/')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      calls += 1;
      if (calls === 1) return firstPending; // 1차 — 의도적으로 오래 걸림(in-flight)
      return { ok: true, status: 200, json: async () => ({ data: epicFixture({ title: '회복된 목표' }) }) }; // 2차
    });

    const { EpicDetailPage, GoalsRouteProvider } = await (async () => {
      vi.stubGlobal('fetch', fetchImpl);
      const pageMod = await import('./page');
      const ctxMod = await import('../goals-context');
      return { EpicDetailPage: pageMod.default, GoalsRouteProvider: ctxMod.GoalsRouteProvider };
    })();

    await act(async () => {
      root.render(wrap(GoalsRouteProvider, <EpicDetailPage />));
      await Promise.resolve();
    });
    expect(calls).toBe(1); // 1차 요청 in-flight, 아직 미해결

    // org-sync 성공 直後 bump — 2차 요청 시작(1차는 여전히 pending).
    const { bumpOrgSyncVersion } = await import('@/lib/project-context-client');
    await act(async () => {
      bumpOrgSyncVersion();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(calls).toBe(2); // 2차 요청 발화됨(성공 mock 즉시 resolve)
    expect(container.textContent).toContain('회복된 목표'); // 2차 성공이 이미 화면에 반영

    // 이제 뒤늦게 1차(옛 org 403)가 resolve — stale-guard가 없으면 여기서 replace가 뒤늦게 발화된다.
    await act(async () => {
      resolveFirst({ ok: false, status: 403, json: async () => null });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(replaceMock).not.toHaveBeenCalled(); // stale 1차가 뒤늦게 replace를 발화하지 않는다
    expect(container.textContent).toContain('회복된 목표'); // 2차 성공 화면 그대로 유지
  });
});

// story #2958(doc goals-outcome-ledger-redesign-handoff §2/§4) — 결과 캡슐(이중 신호)+수직
// 신뢰 레일 재조립 회귀가드.
describe('EpicDetailPage — 결과 캡슐 재조립(§2 이중 신호·§4 신뢰 레일)', () => {
  async function mountByUrl(epicOverrides: Record<string, unknown>, hypotheses: unknown[] = []) {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('/api/hypotheses')) {
        return { ok: true, status: 200, json: async () => ({ data: hypotheses }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: epicFixture(epicOverrides) }) };
    });
    return mount(fetchImpl);
  }

  it('이중 신호 캡슐 2개(작업 CLAIMED/결과 VERIFIED)가 나란히 뜬다', async () => {
    await mountByUrl({ stories: [{ id: 's1', title: 'S1', status: 'done' }, { id: 's2', title: 'S2', status: 'backlog' }], outcome_status: 'pending' });
    expect(container.textContent).toContain('CLAIMED');
    expect(container.textContent).toContain('VERIFIED');
    expect(container.textContent).toContain('1/2');
  });

  it('작업 진척 바는 중립(proof-ink-3)이지 primary가 아니다', async () => {
    await mountByUrl({ stories: [{ id: 's1', title: 'S1', status: 'done' }], outcome_status: 'hit' });
    expect(container.querySelector('.bg-proof-ink-3')).not.toBeNull();
  });

  it('결과 캡슐 — outcome_status=hit이면 "달성"이 뜬다', async () => {
    await mountByUrl({ outcome_status: 'hit' });
    expect(container.textContent).toContain('달성');
  });

  it('결과 캡슐 — outcome_status=miss도 빨강 클래스 없이 렌더된다(soul-lock)', async () => {
    await mountByUrl({ outcome_status: 'miss' });
    expect(container.textContent).toContain('미달');
    expect(container.querySelector('.text-destructive')).toBeNull();
  });

  it('신뢰 레일 — 결과 미판정(pending)+measure_after 있으면 "결과 검증 (예정)"과 측정일이 뜬다', async () => {
    await mountByUrl({ outcome_status: 'pending', measure_after: '2026-09-01' });
    expect(container.textContent).toContain('결과 검증 (예정)');
    expect(container.textContent).toContain('측정 예정');
  });

  it('신뢰 레일 — 결과 판정 완료(hit)면 "결과 확定" 노드로 전환된다', async () => {
    await mountByUrl({ outcome_status: 'hit' });
    expect(container.textContent).toContain('결과 확定');
    expect(container.textContent).not.toContain('결과 검증 (예정)');
  });

  it('신뢰 레일 — 가설이 있으면 개수가 뜨고, 없으면 그 노드 자체가 안 뜬다', async () => {
    await mountByUrl({ outcome_status: 'pending' }, [{ id: 'h1' }, { id: 'h2' }]);
    expect(container.textContent).toContain('가설 2');
  });

  it('신뢰 레일 — "목표 생성" 노드는 항상 뜬다', async () => {
    await mountByUrl({ outcome_status: 'n_a' });
    expect(container.textContent).toContain('목표 생성');
  });
});
