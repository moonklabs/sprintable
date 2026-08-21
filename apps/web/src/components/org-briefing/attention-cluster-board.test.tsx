// @vitest-environment jsdom
//
// story #2541 — 클러스터 카드가 top-N(3)만 기본 노출하고 "전체보기"로 나머지를 펼치는지,
// 데이터 없는 유형은 카드 자체를 안 그리는지(없는 데이터에 화면 안 깎기) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AttentionClusterBoard } from './attention-cluster-board';
import type { AuthFailureClusterItem, FalsifiedClusterItem, StalledClusterItem, LoopClusterItem } from './derive-attention-clusters';

// story #2830 — falsified/stalled 기존 테스트는 loop 신호와 무관하니 빈 값으로 고정(회귀 0).
const NO_LOOP = { loop: [] as LoopClusterItem[], loopTotalCount: 0, measurePlanMissingGoalCount: 0, unmeasurableGoalCount: 0 };

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function stalledItem(i: number): StalledClusterItem {
  return { id: `s${i}`, title: `스토리 ${i}`, days: 10 - i, href: `/board?story=s${i}`, crossProjectLabel: null };
}

describe('AttentionClusterBoard', () => {
  it('셋 다 비어 있으면 아무것도 렌더하지 않는다', async () => {
    await act(async () => { root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[]} {...NO_LOOP} />)); });
    expect(container.innerHTML).toBe('');
  });

  it('데이터 있는 유형만 카드로 그린다(가설 반증 0건이면 그 카드 자체가 없다)', async () => {
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[stalledItem(0)]} {...NO_LOOP} />));
    });
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterStalledTitle);
    expect(container.textContent).not.toContain(koMessages.orgBriefing.clusterFalsifiedTitle);
    expect(container.textContent).not.toContain(koMessages.orgBriefing.clusterUnclosedTitle);
  });

  it('story #2541 AC1 — 20건이 top-3만 기본 노출되고 "전체보기"로 나머지가 펼쳐진다', async () => {
    const items = Array.from({ length: 20 }, (_, i) => stalledItem(i));
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={items} {...NO_LOOP} />));
    });

    let rows = container.querySelectorAll('a');
    expect(rows).toHaveLength(3);
    expect(container.textContent).toContain('17');

    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('전체보기'));
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    rows = container.querySelectorAll('a');
    expect(rows).toHaveLength(20);
  });

  it('가설 반증 카드는 목표→최종 실측과 대체 가설 유무를 보인다', async () => {
    const item: FalsifiedClusterItem = {
      id: 'h1', title: '온보딩 연결 완료율이 오르면 채택이 는다',
      target: 70, actual: 41, hasOutcome: true, supersededId: 'h2', href: '/flow?hypothesis=h1',
      crossProjectLabel: null,
    };
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[item]} stalled={[]} {...NO_LOOP} />));
    });
    expect(container.textContent).toContain('70');
    expect(container.textContent).toContain('41');
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterBegetLinked);
  });

  it('대체 가설이 없으면 미연결 정직 문구를 보인다(대체 가설 제목을 지어내지 않는다)', async () => {
    const item: FalsifiedClusterItem = {
      id: 'h1', title: 'X', target: null, actual: null, hasOutcome: false, supersededId: null, href: '/flow?hypothesis=h1',
      crossProjectLabel: null,
    };
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[item]} stalled={[]} {...NO_LOOP} />));
    });
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterBegetUnlinked);
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterFalsifiedResultUnknown);
  });

  // story #2830 — 「닫힌 적 없는 루프」 클러스터.
  describe('loop cluster (story #2830)', () => {
    function loopItem(overrides: Partial<LoopClusterItem>): LoopClusterItem {
      return { id: 'l1', kind: 'overdueHypothesis', title: '결제 전환 가설', days: 5, href: '/flow?hypothesis=l1', crossProjectLabel: null, ...overrides };
    }

    it('N=0이면 카드 자체를 안 그린다(배경음 방지)', async () => {
      await act(async () => {
        root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[]} loop={[]} loopTotalCount={0} measurePlanMissingGoalCount={40} unmeasurableGoalCount={0} />));
      });
      // measurePlanMissingGoalCount>0이어도 loopTotalCount=0이면 루프 카드 자체가 없다 — 이
      // 보조 텍스트는 루프 카드 안에서만 존재하는 항목이라 카드가 없으면 텍스트도 없어야 한다.
      expect(container.textContent).not.toContain(koMessages.orgBriefing.clusterUnclosedTitle);
    });

    it('배지 색이 destructive(빨강) 아니라 warning 계열이다(방치 신호이지 실패 아님)', async () => {
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={[loopItem({})]} loopTotalCount={1} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      const badge = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === koMessages.orgBriefing.clusterUnclosedBadgeOverdueHypothesis);
      expect(badge).toBeTruthy();
      // aria-invalid: 계열 유틸(모든 배지 base에 공통)은 무시하고 실제 variant 배경 클래스만 본다.
      expect(badge!.className).not.toMatch(/bg-destructive/);
      expect(container.querySelector('.bg-warning, .bg-warning-tint')).toBeTruthy();
    });

    it('count 배지는 loopTotalCount를 쓴다(items.length가 아니라 — BE top-20 cap 대비)', async () => {
      // 실측 시나리오 재현: outcome_missing 51건인데 items[]는 top-20만 옴.
      const items = Array.from({ length: 20 }, (_, i) => loopItem({ id: `g${i}`, kind: 'outcomeMissing', days: i }));
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={items} loopTotalCount={51} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      expect(container.textContent).toContain('51');
    });

    it('top-20 cap이 걸린 채 전체 펼치면 "전체보기"가 아니라 잘림을 정직하게 알린다', async () => {
      const items = Array.from({ length: 20 }, (_, i) => loopItem({ id: `g${i}`, kind: 'outcomeMissing', days: i }));
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={items} loopTotalCount={51} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      // "전체보기" 문구(clusterViewAll)를 쓰면 안 됨 — "더보기"(clusterUnclosedShowMore)만.
      expect(container.textContent).not.toContain('전체보기');
      const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더보기'));
      expect(toggle).toBeTruthy();
      await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(container.textContent).toContain(koMessages.orgBriefing.clusterUnclosedCapNotice
        .replace('{shown}', '20').replace('{total}', '51'));
    });

    // story #2858 — 잘림 고지 옆에 전량 큐 페이지로 가는 실제 경로가 붙는다(no dead-end honesty).
    it('cap 고지에 /loop-queue로 가는 링크가 함께 뜬다', async () => {
      const items = Array.from({ length: 20 }, (_, i) => loopItem({ id: `g${i}`, kind: 'outcomeMissing', days: i }));
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={items} loopTotalCount={51} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더보기'));
      await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const queueLink = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/loop-queue');
      expect(queueLink).toBeTruthy();
      expect(queueLink!.textContent).toBe(koMessages.orgBriefing.clusterUnclosedViewQueue);
    });

    it('measurePlanMissingGoalCount는 N에 안 더해지고 보조 텍스트로만 노출된다', async () => {
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={[loopItem({})]} loopTotalCount={1} measurePlanMissingGoalCount={40} unmeasurableGoalCount={0} />,
        ));
      });
      const countBadge = container.querySelector('.rounded-full.bg-card');
      expect(countBadge?.textContent).toBe('1'); // 40이 합산 안 됨
      expect(container.textContent).toContain('40');
    });

    // story #2843/#2844 — unmeasurableGoalCount도 measurePlanMissingGoalCount와 동형(N 비합산·보조텍스트).
    it('unmeasurableGoalCount도 N에 안 더해지고 보조 텍스트로만 노출된다', async () => {
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={[loopItem({})]} loopTotalCount={1} measurePlanMissingGoalCount={0} unmeasurableGoalCount={7} />,
        ));
      });
      const countBadge = container.querySelector('.rounded-full.bg-card');
      expect(countBadge?.textContent).toBe('1'); // 7이 합산 안 됨
      expect(container.textContent).toContain(
        koMessages.orgBriefing.clusterUnclosedUnmeasurableGoal.replace('{count}', '7'),
      );
    });

    it('행 클릭 href가 outcome 판정 UI(/flow?goal=·/flow?hypothesis=)로 간다(유나 스티어③)', async () => {
      // goal href는 view=flow를 반드시 동반한다(유나 design:changes, PR#3257) — 없으면
      // 데스크톱 parseView 기본값('hypothesis')에 밀려 focusGoalId가 조용히 드롭된다.
      const items = [
        loopItem({ id: 'h1', kind: 'overdueHypothesis', href: '/flow?hypothesis=h1' }),
        loopItem({ id: 'g1', kind: 'outcomeMissing', href: '/flow?view=flow&goal=g1' }),
      ];
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={items} loopTotalCount={2} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/flow?hypothesis=h1');
      expect(hrefs).toContain('/flow?view=flow&goal=g1');
    });

    // story #2842(0b17472c) — cross-project 항목만 프로젝트 slug 배지가 붙는다(노이즈 절제).
    it('crossProjectLabel이 있는 항목만 프로젝트 태그가 보인다', async () => {
      const items = [
        loopItem({ id: 'same', title: '같은 프로젝트', crossProjectLabel: null }),
        loopItem({ id: 'other', title: '다른 프로젝트', crossProjectLabel: 'other-proj' }),
      ];
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} loop={items} loopTotalCount={2} measurePlanMissingGoalCount={0} unmeasurableGoalCount={0} />,
        ));
      });
      expect(container.textContent).toContain('other-proj');
      expect(container.textContent?.match(/other-proj/g)).toHaveLength(1);
    });
  });

  // story #2852(2836 FE 조각, BE PR#3266) — 에이전트 인증 실패 클러스터.
  describe('agent auth failure cluster (story #2852)', () => {
    function authFailureItem(overrides: Partial<AuthFailureClusterItem>): AuthFailureClusterItem {
      return { id: 'a1', memberId: 'm1', reason: 'expired', failureCount: 6, firstFailedAt: null, lastFailedAt: null, ...overrides };
    }

    it('N=0이면 카드 자체를 안 그린다(AC4)', async () => {
      await act(async () => {
        root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[]} {...NO_LOOP} authFailure={[]} />));
      });
      expect(container.textContent).not.toContain(koMessages.orgBriefing.clusterAuthFailureTitle);
    });

    // AC1 — BE severity:"danger"를 시각으로 직결하지 않고 warning 톤을 쓴다(destructive 금지).
    it('destructive(빨강)를 쓰지 않고 warning 계열을 쓴다(AC1)', async () => {
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} {...NO_LOOP} authFailure={[authFailureItem({})]} />,
        ));
      });
      expect(container.innerHTML).not.toMatch(/bg-destructive/);
      expect(container.querySelector('.bg-warning-tint')).toBeTruthy();
    });

    // AC3 — reason enum을 raw로 노출하지 않고 유저 어휘로 매핑 + 진단(최근 5분 N회) + 재발급 링크.
    it('reason이 raw enum 아니라 유저 어휘로 매핑되고 진단·재발급 링크가 함께 뜬다(AC3)', async () => {
      const memberNames = { m1: '디디 은두카쿠' };
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} {...NO_LOOP} authFailure={[authFailureItem({ reason: 'revoked', failureCount: 9 })]} memberNames={memberNames} />,
        ));
      });
      expect(container.textContent).not.toContain('revoked'); // raw enum 유출 금지
      expect(container.textContent).toContain(koMessages.orgBriefing.clusterAuthFailureReasonRevoked);
      expect(container.textContent).toContain('디디 은두카쿠');
      expect(container.textContent).toContain('9');
      const link = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/organization/workforce/m1');
      expect(link).toBeTruthy();
    });

    it('memberNames에 이름이 없으면(또는 memberId가 null) 이름 폴백 문구를 쓴다(no-fiction)', async () => {
      await act(async () => {
        root.render(wrap(
          <AttentionClusterBoard falsified={[]} stalled={[]} {...NO_LOOP} authFailure={[authFailureItem({ memberId: null, reason: 'invalid' })]} />,
        ));
      });
      expect(container.textContent).toContain(koMessages.orgBriefing.clusterAuthFailureUnknownAgent);
      // memberId가 없으면 재발급 링크 자체를 안 만든다(어디로 갈지 지어낼 수 없음).
      expect(container.querySelectorAll('a')).toHaveLength(0);
    });
  });
});
