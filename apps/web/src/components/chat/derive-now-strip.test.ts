import { describe, expect, it } from 'vitest';
import type { useTranslations } from 'next-intl';
import type { AttentionItem } from '@/components/dashboard/command-center/types';
import {
  normalizeSeverity,
  nowStripItemKey,
  nowStripItemHref,
  buildNowStripItems,
  summarizeSeverity,
} from './derive-now-strip';

// story #3177(S3a) — 스텁 번역기(내용은 action-zone.test.tsx가 이미 attentionDetailText로
// 잰다, 여기선 derive-now-strip 자신의 로직만: 정렬·key·href·severity 정규화·요약). next-intl
// 번역기 실 타입(rich/markup/raw/has)은 이 순수함수 유닛테스트 관심사가 아니라 캐스트로
// 좁힌다.
const t = ((key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${JSON.stringify(values)})` : key) as unknown as ReturnType<typeof useTranslations>;

const AGENT_STUCK: AttentionItem = {
  type: 'agent_stuck',
  severity: 'warn',
  auto_detected: true,
  entity_type: 'story',
  entity_id: 's-1',
  gate_type: 'merge',
  stuck_since: '2026-08-20T00:00:00Z',
};

const AGENT_AUTH_FAILURE: AttentionItem = {
  type: 'agent_auth_failure',
  severity: 'danger',
  auto_detected: true,
  member_id: 'm-1',
  reason: 'revoked',
  failure_count: 3,
  first_failed_at: null,
  last_failed_at: null,
};

const UNANSWERED_BLOCKER: AttentionItem = {
  type: 'unanswered_blocker',
  severity: 'warn',
  auto_detected: true,
  blocked_story_id: 'story-2',
  blocker_id: 'story-3',
  blocked_story_title: '온보딩 완주 체크',
  age_days: 5,
  project_id: 'p-1',
};

const HYPOTHESIS_FALSIFIED: AttentionItem = {
  type: 'hypothesis_falsified',
  severity: 'info',
  auto_detected: true,
  hypothesis_id: 'h-1',
  statement: '가입 전환율 개선 가설',
  outcome_result: null,
  falsified_days: 3,
  superseded_by_hypothesis_id: null,
  project_id: 'p-1',
};

const LOOP_OVERDUE_HYPOTHESIS: AttentionItem = {
  type: 'loop_overdue_hypothesis',
  severity: 'warn',
  auto_detected: true,
  hypothesis_id: 'h-2',
  statement: '리텐션 D7 가설',
  owner_member_id: null,
  overdue_days: 4,
  project_id: 'p-1',
};

const LOOP_OVERDUE_GOAL: AttentionItem = {
  type: 'loop_overdue_goal',
  severity: 'warn',
  auto_detected: true,
  goal_id: 'g-1',
  title: '가입 전환율 개선',
  owner_member_id: null,
  overdue_days: 10,
  project_id: 'p-1',
};

const LOOP_OUTCOME_MISSING_GOAL: AttentionItem = {
  type: 'loop_outcome_missing_goal',
  severity: 'warn',
  auto_detected: true,
  goal_id: 'g-2',
  title: '온보딩 완주율',
  owner_member_id: null,
  done_days: 7,
  project_id: 'p-1',
};

const ALL_SEVEN = [
  AGENT_STUCK,
  AGENT_AUTH_FAILURE,
  UNANSWERED_BLOCKER,
  HYPOTHESIS_FALSIFIED,
  LOOP_OVERDUE_HYPOTHESIS,
  LOOP_OVERDUE_GOAL,
  LOOP_OUTCOME_MISSING_GOAL,
];

describe('normalizeSeverity — no-fiction: 모르는 값은 info로 가라앉힌다(danger를 지어내지 않음)', () => {
  it.each(['danger', 'warn', 'info'] as const)('%s는 그대로 통과한다', (s) => {
    expect(normalizeSeverity(s)).toBe(s);
  });

  it('모르는 문자열은 info로 떨어진다', () => {
    expect(normalizeSeverity('critical')).toBe('info');
    expect(normalizeSeverity('')).toBe('info');
  });
});

describe('nowStripItemKey — 7종 각자 안정 key(SID 3150 회귀 금지, generic entity_id 미의존)', () => {
  it('7종 전부 고유하고 안정적인 key를 만든다', () => {
    const keys = ALL_SEVEN.map(nowStripItemKey);
    expect(new Set(keys).size).toBe(7);
    expect(keys).toContain('agent_stuck-s-1');
    expect(keys).toContain('agent_auth_failure-m-1');
    expect(keys).toContain('unanswered_blocker-story-2');
    expect(keys).toContain('hypothesis_falsified-h-1');
    expect(keys).toContain('loop_overdue_hypothesis-h-2');
    expect(keys).toContain('loop_overdue_goal-g-1');
    expect(keys).toContain('loop_outcome_missing_goal-g-2');
  });
});

describe('nowStripItemHref — §1a 링크 대상(원탭 도달)', () => {
  it('agent_stuck(entity_type=story)은 보드로', () => {
    expect(nowStripItemHref(AGENT_STUCK)).toBe('/board?story=s-1');
  });

  it('agent_stuck(entity_type≠story, 예: epic)은 게이트 인박스로(제네릭 폴백)', () => {
    expect(nowStripItemHref({ ...AGENT_STUCK, entity_type: 'epic' })).toBe('/inbox?tab=gates');
  });

  it('agent_auth_failure는 워크포스 멤버 상세로', () => {
    expect(nowStripItemHref(AGENT_AUTH_FAILURE)).toBe('/organization/workforce/m-1');
  });

  it('unanswered_blocker는 차단 스토리 보드로', () => {
    expect(nowStripItemHref(UNANSWERED_BLOCKER)).toBe('/board?story=story-2');
  });

  it('hypothesis 2종(falsified/overdue)은 전용 상세 페이지가 없어(embed-card.tsx 실측) /flow로', () => {
    expect(nowStripItemHref(HYPOTHESIS_FALSIFIED)).toBe('/flow');
    expect(nowStripItemHref(LOOP_OVERDUE_HYPOTHESIS)).toBe('/flow');
  });

  it('goal 2종(overdue/outcome-missing)은 /goals/[id]로', () => {
    expect(nowStripItemHref(LOOP_OVERDUE_GOAL)).toBe('/goals/g-1');
    expect(nowStripItemHref(LOOP_OUTCOME_MISSING_GOAL)).toBe('/goals/g-2');
  });
});

describe('buildNowStripItems — severity 정렬(danger→warn→info)', () => {
  it('입력 순서와 무관하게 danger가 먼저, info가 마지막에 온다', () => {
    const items = buildNowStripItems(ALL_SEVEN, t);
    expect(items).toHaveLength(7);
    const severities = items.map((i) => i.severity);
    const firstInfoIdx = severities.indexOf('info');
    const lastDangerIdx = severities.lastIndexOf('danger');
    const firstWarnIdx = severities.indexOf('warn');
    expect(lastDangerIdx).toBeLessThan(firstWarnIdx === -1 ? Infinity : firstWarnIdx);
    expect(firstWarnIdx === -1 || firstWarnIdx < firstInfoIdx || firstInfoIdx === -1).toBe(true);
    expect(severities[0]).toBe('danger'); // AGENT_AUTH_FAILURE(유일한 danger)가 앞으로.
  });

  it('resolveName/epicTitles를 안 넘겨도 no-fiction 폴백(entity_type)으로 죽지 않는다', () => {
    const items = buildNowStripItems([AGENT_STUCK], t);
    expect(items[0]!.title).toBe('story'); // resolveName 없음 → entity_type 폴백.
  });

  it('agent_stuck 라벨은 resolveName이 있으면 그걸 우선한다(action-zone.tsx attentionEntityLabel 재사용 증거)', () => {
    const items = buildNowStripItems([AGENT_STUCK], t, (id) => (id === 's-1' ? '온보딩 완주 체크' : null));
    expect(items[0]!.title).toBe('온보딩 완주 체크');
  });

  it('빈 배열이면 빈 배열을 낸다', () => {
    expect(buildNowStripItems([], t)).toEqual([]);
  });
});

describe('summarizeSeverity — collapsed 「지금 N」 정직 카운트', () => {
  it('7종(danger 1·warn 5·info 1)을 정확히 센다', () => {
    const items = buildNowStripItems(ALL_SEVEN, t);
    expect(summarizeSeverity(items)).toEqual({ danger: 1, warn: 5, info: 1, total: 7 });
  });

  it('빈 목록은 전부 0', () => {
    expect(summarizeSeverity([])).toEqual({ danger: 0, warn: 0, info: 0, total: 0 });
  });
});
