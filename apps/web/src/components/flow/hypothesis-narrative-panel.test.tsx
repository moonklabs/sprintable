// @vitest-environment jsdom
//
// story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사 패널. 리라이트(2026-08-09): BE
// `GET /hypotheses/{id}/lifecycle`(story #2533-BE, PR#2931) 단일 응답을 소비한다(이전
// N+1 goals/{id}·stories?ids= 조합을 교체). base-ui Dialog는 document.body에 portal
// 렌더하므로(storage-delete-dialog.test.tsx와 동일 관례) document 전체를 대상으로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HypothesisNarrativePanel } from './hypothesis-narrative-panel';
import { bumpOrgSyncVersion } from '@/lib/project-context-client';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

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

interface LifecycleFixtureOverrides {
  hypothesis?: Partial<{
    id: string; statement: string; status: string;
    metric_definition: { metric?: string; target?: number; direction?: string } | null;
    outcome_result: Record<string, unknown> | null;
  }>;
  goals?: Array<{ id: string; title: string; status: string }>;
  stories?: Array<{ id: string; title: string; status: string; metric_definition: unknown; outcome_status: string; gate_status: string | null; evidence_count: number }>;
  superseded_by?: { id: string; statement: string; status: string } | null;
  supersedes?: Array<{ id: string; statement: string; status: string }>;
  timeline?: { created_at: string; measure_after: string; updated_at: string };
}

function makeLifecycle(overrides: LifecycleFixtureOverrides = {}) {
  return {
    hypothesis: {
      id: 'h1', statement: '기본 진술', status: 'measuring',
      metric_definition: { metric: 'm', target: 0, direction: 'down' },
      outcome_result: null,
      ...overrides.hypothesis,
    },
    goals: overrides.goals ?? [],
    stories: overrides.stories ?? [],
    superseded_by: overrides.superseded_by ?? null,
    supersedes: overrides.supersedes ?? [],
    timeline: overrides.timeline ?? { created_at: '2026-07-01T00:00:00Z', measure_after: '2026-08-01T00:00:00Z', updated_at: '2026-07-15T00:00:00Z' },
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
});

async function renderPanel(
  fetchImpl: typeof fetch,
  onClose: () => void = vi.fn(),
  onNavigateToGoal?: (goalId: string) => void,
) {
  vi.stubGlobal('fetch', fetchImpl);
  await act(async () => {
    root.render(wrap(<HypothesisNarrativePanel hypothesisId="h1" onClose={onClose} onNavigateToGoal={onNavigateToGoal} />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

// lifecycle 라우트는 reference-candidates/attachment-suggestions와 동형 raw thin-proxy
// (래핑 없음) — {data} 봉투를 안 씌운다.
function rawFetch(data: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(data), { status: 200 })));
}

describe('HypothesisNarrativePanel — story #2533, lifecycle 단일 응답 소비', () => {
  it('/api/hypotheses/{id}/lifecycle 하나만 호출한다(N+1 없음)', async () => {
    const fetchMock = rawFetch(makeLifecycle());
    await renderPanel(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/hypotheses/h1/lifecycle', { cache: 'no-store' });
  });

  it('질문(statement)이 렌더된다', async () => {
    await renderPanel(rawFetch(makeLifecycle({ hypothesis: { statement: '결제 완료율 가설' } })));
    expect(document.body.textContent).toContain('결제 완료율 가설');
  });

  it('목표(goals[].title)가 렌더된다', async () => {
    await renderPanel(rawFetch(makeLifecycle({ goals: [{ id: 'g1', title: '결제 전환 목표', status: 'active' }] })));
    expect(document.body.textContent).toContain('결제 전환 목표');
  });

  it('goals가 비어있으면 목표 절이 정직한 "아직"을 보인다', async () => {
    await renderPanel(rawFetch(makeLifecycle({ goals: [] })));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeNotYet);
  });

  // story #2535(E-FLOW-V4 S5) — 지구→대륙 다리. onNavigateToGoal이 주어지면 목표 항목이
  // 클릭 가능해지고, 누르면 그 목표 id로 콜백이 온다(네비게이션 자체는 호출부 책임).
  it('onNavigateToGoal이 있으면 목표 항목이 클릭 가능하고, 누르면 goalId로 호출된다', async () => {
    const onNavigateToGoal = vi.fn();
    await renderPanel(
      rawFetch(makeLifecycle({ goals: [{ id: 'g1', title: '결제 전환 목표', status: 'active' }] })),
      vi.fn(),
      onNavigateToGoal,
    );

    const goalButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('결제 전환 목표'));
    expect(goalButton).toBeTruthy();
    await act(async () => {
      goalButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onNavigateToGoal).toHaveBeenCalledWith('g1');
  });

  it('onNavigateToGoal이 없으면(옵셔널) 목표 항목은 그냥 텍스트로만 렌더된다(회귀 없음)', async () => {
    await renderPanel(rawFetch(makeLifecycle({ goals: [{ id: 'g1', title: '결제 전환 목표', status: 'active' }] })));

    expect(document.body.textContent).toContain('결제 전환 목표');
    const goalButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('결제 전환 목표'));
    expect(goalButton).toBeUndefined();
  });

  it('검증(stories[].title)이 렌더된다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      stories: [
        { id: 's1', title: '스토리A', status: 'in-progress', metric_definition: null, outcome_status: 'n_a', gate_status: null, evidence_count: 0 },
        { id: 's2', title: '스토리B', status: 'done', metric_definition: null, outcome_status: 'n_a', gate_status: null, evidence_count: 0 },
      ],
    })));
    expect(document.body.textContent).toContain('스토리A');
    expect(document.body.textContent).toContain('스토리B');
  });

  it('증명(outcome_result)이 실측/목표로 렌더된다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'falsified', outcome_result: { actual: 52, target: 60, metric: 'x', direction: 'up' } },
    })));
    expect(document.body.textContent).toContain('52');
    expect(document.body.textContent).toContain('60');
  });

  it('falsified면 증명 절에 "목표 미달"이 명시된다(follow-up②, 색 아니라 방향으로 읽힘)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'falsified', outcome_result: { actual: 52, target: 60 } },
    })));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeMissedTarget);
  });

  it('verified면 "목표 미달" 문구가 안 뜬다(falsified 전용)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'verified', outcome_result: { actual: 65, target: 60 } },
    })));
    expect(document.body.textContent).not.toContain(koMessages.flow.narrativeMissedTarget);
  });

  it('killed면 outcome_result가 {reason}뿐이라 종료 사유로 렌더된다(카디르 재QA 비차단①)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'killed', outcome_result: { reason: '우선순위 밀림' } },
    })));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeKilledReason.replace('{reason}', '우선순위 밀림'));
  });

  it('killed인데 reason도 없으면 증명 절이 빈 값을 지어내지 않고 아무것도 안 그린다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'killed', outcome_result: {} },
    })));
    const proofSection = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === koMessages.flow.narrativeStepProof);
    expect(proofSection?.closest('div')?.textContent).not.toContain('undefined');
  });

  it('증명 절이 스토리별 gate/evidence를 간접조회로 보여준다(PR#2930 리뷰② 해소)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      stories: [{ id: 's1', title: '스토리A', status: 'done', metric_definition: null, outcome_status: 'verified', gate_status: 'approved', evidence_count: 3 }],
    })));
    expect(document.body.textContent).toContain('approved');
    expect(document.body.textContent).toContain('3');
  });

  it('gate_status가 null이면(매칭 없음) 정직하게 "아직"을 보인다(지어내지 않는다)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      stories: [{ id: 's1', title: '스토리A', status: 'in-progress', metric_definition: null, outcome_status: 'n_a', gate_status: null, evidence_count: 0 }],
    })));
    const proofSection = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === koMessages.flow.narrativeStepProof);
    expect(proofSection).toBeTruthy();
    expect(document.body.textContent).toContain(koMessages.flow.narrativeNotYet);
  });

  it('시간선 캡션(전이 이력 전체 아님, PR#2930 리뷰①)이 렌더된다', async () => {
    await renderPanel(rawFetch(makeLifecycle()));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeTimelineCaption);
  });

  // story #3493 — created_at/updated_at은 "기록"(정본 formatRelativeTime, 7일 초과라
  // §11-2 절대 표기로 폴백)·measure_after는 미래 "약속"(정본 formatScheduledAt 그대로).
  // 하드코딩 'ko-KR'/toLocaleDateString 대신 실제 소비 정본 함수로 기대값을 계산해
  // 테스트 실행 환경의 타임존에 관계없이 결정적이게 한다.
  it('시간선 3점이 렌더되고, 자리별 정본(기록=formatRelativeTime·약속=formatScheduledAt)으로 포맷된다(PR#2930 리뷰④ 계승 + story #3493)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      timeline: { created_at: '2026-07-01T00:00:00Z', measure_after: '2026-08-01T00:00:00Z', updated_at: '2026-07-15T00:00:00Z' },
    })));
    const displayTimezone = resolveDisplayTimezone().tz;
    // 셋 다 "now"(2026-09-05 기준 테스트 실행 시각) 대비 7일을 훌쩍 넘긴 과거라
    // formatRelativeTime도 formatScheduledAt과 동일한 절대 표기로 폴백한다.
    expect(document.body.textContent).toContain(formatScheduledAt('2026-07-01T00:00:00Z', displayTimezone).display);
    expect(document.body.textContent).toContain(formatScheduledAt('2026-08-01T00:00:00Z', displayTimezone).display);
    expect(document.body.textContent).toContain(formatScheduledAt('2026-07-15T00:00:00Z', displayTimezone).display);
  });

  it('fetch 실패 시 에러 문구를 보이고 크래시하지 않는다', async () => {
    await renderPanel(vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeLoadError);
  });
});

describe('HypothesisNarrativePanel — 정반합 양방향(superseded_by/supersedes)', () => {
  it('둘 다 비어있으면(대부분의 가설) 정반합 절 자체가 안 뜬다', async () => {
    await renderPanel(rawFetch(makeLifecycle({ superseded_by: null, supersedes: [] })));
    expect(document.body.textContent).not.toContain(koMessages.flow.narrativeStepAntithesis);
    expect(document.body.textContent).not.toContain(koMessages.flow.narrativeStepSupersedes);
  });

  it('superseded_by가 있으면(이 가설이 대체됨) 대체 가설 문장이 뜬다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'falsified' },
      superseded_by: { id: 'h2', statement: '대체 가설 문장', status: 'proposed' },
    })));
    expect(document.body.textContent).toContain('대체 가설 문장');
    expect(document.body.textContent).toContain(koMessages.flow.narrativeStepAntithesis);
  });

  it('superseded_by가 있으면 "낳음" 프레이밍 문구가 도드라진다(follow-up③ — 닫힘 아니라 낳음)', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { status: 'falsified' },
      superseded_by: { id: 'h2', statement: '대체 가설 문장', status: 'proposed' },
    })));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeSpawned);
  });

  it('supersedes가 있으면(이 가설이 이전 가설을 대체함, 역방향) 전신 가설 문장이 뜬다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      supersedes: [{ id: 'h0', statement: '전신 가설 문장', status: 'falsified' }],
    })));
    expect(document.body.textContent).toContain('전신 가설 문장');
    expect(document.body.textContent).toContain(koMessages.flow.narrativeStepSupersedes);
  });

  it('백필 실사례(2cbdd1a9 falsified↔724dde46 proposed) 형태를 값으로 재현한다', async () => {
    await renderPanel(rawFetch(makeLifecycle({
      hypothesis: { id: '2cbdd1a9', statement: '체크아웃을 2단계로 줄이면 결제 완료율이 오른다', status: 'falsified', outcome_result: { actual: 52, target: 60 } },
      superseded_by: { id: '724dde46', statement: '[유나 편집] 결제 완료율은 단계 수보다 신뢰 신호에 더 크게 좌우될 것이다', status: 'proposed' },
    })));
    expect(document.body.textContent).toContain('체크아웃을 2단계로 줄이면 결제 완료율이 오른다');
    expect(document.body.textContent).toContain('신뢰 신호');
  });
});

describe('HypothesisNarrativePanel — 닫기', () => {
  it('닫기 상호작용 시 onClose가 호출된다(base-ui Dialog onOpenChange 경로)', async () => {
    const onClose = vi.fn();
    await renderPanel(rawFetch(makeLifecycle()), onClose);

    const candidates = Array.from(document.querySelectorAll('[data-slot="dialog-content"] button'));
    expect(candidates[0]).toBeTruthy();
    await act(async () => {
      candidates[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});

// story #2545(카디르 라이브 재QA 5단계) — hypothesisId는 URL `?hypothesis=`가 정본이라
// org-switch 前後로 동일 id를 유지한 채(딥링크 cold entry) 이 패널이 떠 있을 수 있다. org
// 불일치 자동교정(switch-org) 성공 直後 재요청되는지 고정한다.
describe('HypothesisNarrativePanel — org-sync 성공 後 재요청 (story #2545)', () => {
  it('bumpOrgSyncVersion() 호출 時 hypothesisId가 그대로여도 재요청된다', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(makeLifecycle()), { status: 200 }));
    });
    await renderPanel(fetchImpl);
    const callsAfterMount = calls;
    expect(callsAfterMount).toBeGreaterThan(0);

    await act(async () => {
      bumpOrgSyncVersion();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calls).toBeGreaterThan(callsAfterMount); // 재요청 — 이전엔 안 늘었다(RED)
  });
});
