/**
 * story #3177(S3a·SID 3177) — chat 구심점 상단 고정 「지금」 스트립. command-center attention
 * 7종을 chat 임베드 카드로 흡수한다. AC 뼈 = doc 「S3 와이어 심화」§1(entity:doc:14bf3247-
 * ae2f-49d0-92b0-986e8902d00a). BE 계약(PO 확定 2026-08-28) — 신규 BE 0, 기존
 * `GET /api/dashboard/my-actions`(attention.items) 그대로 재사용.
 *
 * ⚠️ SID 3150(58건 공백 렌더) 회귀 금지 — 7종 중 6종은 entity_id/entity_type이 없다
 * (types.ts AttentionItem 주석). 이 파일은 generic entity_id에 의존하지 않고 §1a 표의
 * 타입별 «라벨 근거 필드»만 쓴다 — action-zone.tsx의 attentionEntityLabel/attentionDayCount/
 * attentionDetailText를 그대로 재사용한다(두 벌 금지, §1b).
 *
 * BE가 attention 종을 늘리면 이 파일도 함께 고쳐야 한다(3곳 동기화 경계: types.ts +
 * action-zone.tsx attentionEntityLabel/attentionDayCount + 이 파일의 href/icon 매핑).
 */
import type { useTranslations } from 'next-intl';
import type { AttentionItem } from '@/components/dashboard/command-center/types';
import { attentionEntityLabel, attentionDetailText } from '@/components/dashboard/command-center/action-zone';

export type NowStripSeverity = 'danger' | 'warn' | 'info';

// BE severity(자유 문자열)를 렌더 가능한 3종으로 좁힌다 — 모르는 값은 no-fiction 원칙상
// 가장 눈에 덜 띄는 info로 가라앉힌다(위조로 danger를 지어내지 않는다).
const KNOWN_SEVERITIES = new Set<NowStripSeverity>(['danger', 'warn', 'info']);
export function normalizeSeverity(raw: string): NowStripSeverity {
  return (KNOWN_SEVERITIES.has(raw as NowStripSeverity) ? raw : 'info') as NowStripSeverity;
}

const SEVERITY_RANK: Record<NowStripSeverity, number> = { danger: 0, warn: 1, info: 2 };

/** attention item의 안정 key — 7종 각자 id 필드명이 달라(action-zone.tsx attentionItemKey와
 * 동형 문제) 타입별로 뽑는다. */
export function nowStripItemKey(item: AttentionItem): string {
  switch (item.type) {
    case 'agent_stuck': return `agent_stuck-${item.entity_id}`;
    case 'agent_auth_failure': return `agent_auth_failure-${item.member_id}`;
    case 'unanswered_blocker': return `unanswered_blocker-${item.blocked_story_id}`;
    case 'hypothesis_falsified': return `hypothesis_falsified-${item.hypothesis_id}`;
    case 'loop_overdue_hypothesis': return `loop_overdue_hypothesis-${item.hypothesis_id}`;
    case 'loop_overdue_goal': return `loop_overdue_goal-${item.goal_id}`;
    case 'loop_outcome_missing_goal': return `loop_outcome_missing_goal-${item.goal_id}`;
  }
}

/** §1a 「링크 대상(도달)」— 원탭 도달 경로. agent_stuck은 NowFace(org-briefing/derive-now-face.ts)
 * 선례와 동형(entity_type이 story면 보드로, 아니면 게이트 인박스로). agent_auth_failure는
 * organization/workforce/[id](member_id) 상세로. loop_overdue_goal/loop_outcome_missing_goal은
 * `/goals/[id]/page.tsx`(실존 라우트)로.
 *
 * ⚠️hypothesis(hypothesis_falsified/loop_overdue_hypothesis)는 전용 상세 페이지가 없다
 * (embed-card.tsx 실측 그라운딩 — hypothesis는 epic/story/sprint 다대다 링크테이블이라 "담긴
 * 곳 하나"를 못 정해 getEntityHref류가 늘 null을 반환한다, 그 파일 주석: "hypothesis 전용
 * 화면이 생기면 승격"). action-zone.tsx의 기존 AttentionRow도 이 두 타입엔 애초에 href
 * 자체가 없다(비-인터랙티브 div) — 그래서 `/flow`(가설이 실제로 보이는 일반 캔버스,
 * goal-stem-card.tsx/guided-hypothesis-entry.tsx 소비처)로 보낸다. 특정 가설로 바로
 * 스크롤/하이라이트하는 정밀 도달은 전용 화면이 생기기 전엔 구조적으로 불가 — 이 스토리
 * 범위 밖(후속 표면 작업 몫, embed-card.tsx와 동일 한계 상속).
 *
 * 이 스토리(구조 층) 범위에서는 project_slug 기반 완전 경로 조립(§2842 교훈)까지는 하지
 * 않는다 — project_id/slug가 없는 6종은 활성 프로젝트 쿠키로 해소된다(action-zone.tsx
 * AttentionRow와 동일 한계). §1a 표는 「무엇에 도달하나」만 규정하지 「어느 프로젝트로」는
 * 이 스토리 범위 밖(크로스 프로젝트 정합은 후속 표면 작업 몫).
 */
export function nowStripItemHref(item: AttentionItem): string {
  switch (item.type) {
    case 'agent_stuck':
      return item.entity_type === 'story' ? `/board?story=${item.entity_id}` : '/inbox?tab=gates';
    case 'agent_auth_failure':
      return `/organization/workforce/${item.member_id}`;
    case 'unanswered_blocker':
      return `/board?story=${item.blocked_story_id}`;
    case 'hypothesis_falsified':
    case 'loop_overdue_hypothesis':
      return '/flow';
    case 'loop_overdue_goal':
    case 'loop_outcome_missing_goal':
      return `/goals/${item.goal_id}`;
  }
}

export interface NowStripItem {
  key: string;
  type: AttentionItem['type'];
  severity: NowStripSeverity;
  title: string;
  detail: string;
  href: string;
}

/** raw attention.items → 렌더 항목. resolveName/epicTitles는 agent_stuck 라벨에만 쓰인다
 * (action-zone.tsx와 동일 계약) — chat 목록 표면은 팀원 이름 맵을 따로 안 갖고 있을 수
 * 있어 둘 다 옵셔널, 없으면 attentionEntityLabel 자체의 폴백(entity_type)이 no-fiction을
 * 지킨다. */
export function buildNowStripItems(
  items: AttentionItem[],
  t: ReturnType<typeof useTranslations>,
  resolveName: (id: string | null | undefined) => string | null = () => null,
  epicTitles: Record<string, string> = {},
): NowStripItem[] {
  const out = items.map((item) => ({
    key: nowStripItemKey(item),
    type: item.type,
    severity: normalizeSeverity(item.severity),
    title: attentionEntityLabel(item, resolveName, epicTitles),
    detail: attentionDetailText(t, item),
    href: nowStripItemHref(item),
  }));
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export interface NowStripSeveritySummary {
  danger: number;
  warn: number;
  info: number;
  total: number;
}

export function summarizeSeverity(items: NowStripItem[]): NowStripSeveritySummary {
  const summary = { danger: 0, warn: 0, info: 0, total: items.length };
  for (const item of items) summary[item.severity]++;
  return summary;
}
