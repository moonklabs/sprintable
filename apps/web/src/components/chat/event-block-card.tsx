'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { renderBlockTemplate, type BlockTemplate, type BlockTemplateBlock, type EventDefinitionSummary } from '@/lib/block-template';
import { extractBackendErrorMessage } from '@/lib/api-error-message';
import { EntityChip, getEntityHref } from '@/components/chat/embed-card';
import { parseEntityRef, unescapeReferenceLabel } from '@/components/chat/entity-ref';
import { useOrgDomainLabels } from '@/hooks/use-org-domain-labels';
import { gateStatusLabel } from '@/lib/gate-status-label';
import { gateTypeLabel } from '@/lib/gate-type-label';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { entityTypeLabel } from '@/components/chat/chat-input-entity-tokens';
import { formatLocaleDateTime } from '@/lib/i18n';
import { isLocalizedPlatformPreset, localizePresetBlockTemplate, presetName } from '@/lib/platform-preset-copy';
import { useFlatHref } from '@/hooks/use-flat-href';

// story #3893 CHANGES①(PO PR#4298 리뷰 2026-09-15) — outcome-intent-fields.tsx의
// INTERNAL_METRICS와 동일 닫힌 집합(outcomeLoop.metric_{slug} 낱말이 실존하는 metric
// 이름만) — 이 목록 밖은 GA4 소스의 임의 문자열이라 번역 대상이 아니다(단위 생략).
const METRIC_UNIT_KEYS = ['velocity', 'backlog_remaining', 'progress', 'completion_pct'] as const;

// story #3893 CHANGES(PO PR#4298 2차 리뷰 2026-09-15) — preset.goal.measured의
// 「출처」 필드가 `{{payload.source}}`(raw slug "internal_ops"/"ga4")를 그대로 노출했다
// (metric_unit과 같은 클래스 결함 — 「raw slug 0」은 코드 낱말이 사용자에게 보이는지가
// 기준이지, 렌더 성공 여부가 아니다). outcome_scorer.py 그라운딩상 이 preset의 실
// source 값은 "internal_ops"/"ga4" 둘뿐(닫힌 집합) — hypotheses 네임스페이스의 기존
// sourceInternal/sourceGa4 낱말(hypothesis-form.tsx 등 4곳이 이미 씀, 신규 어간 0)을
// 그대로 재사용한다. 미등재 값은 라벨을 안 채워 optional 필드 생략(metric_unit과 동일
// 원칙 — 지어내지 않는다).
const SOURCE_LABEL_KEYS: Record<string, 'sourceInternal' | 'sourceGa4'> = {
  internal_ops: 'sourceInternal',
  ga4: 'sourceGa4',
};

// story #3881(customer-zero) — story status_changed preset의 {{label.from_status}}/
// {{label.to_status}} 해소용. story-detail-panel.tsx:846의 statusKeyMap과 동형(그 파일은
// export 안 해 재사용 불가 — 이 저장소 기존 관례가 이미 소비처마다 로컬 복제, kanban-
// list-view.tsx/story-card.tsx 등도 각자 갖고 있다. 새 공유 모듈 신설은 이 스토리 범위 밖).
const STORY_STATUS_KEY_MAP: Record<string, string> = {
  backlog: 'backlog',
  'ready-for-dev': 'readyForDev',
  'in-progress': 'inProgress',
  'in-review': 'inReview',
  done: 'done',
};

interface EventBlockCardProps {
  /** story #2637 AC2/PO 리뷰(head 80319636c ①) — 파싱은 chat-bubble.tsx가 미리 끝낸다. 이
   * 컴포넌트는 "파싱된 템플릿이 있을 때만" 렌더되고, 파싱 실패/부재는 chat-bubble.tsx가 이
   * 컴포넌트를 아예 안 부르고 기존 ChatMarkdown(제네릭 content) 경로로 보낸다 — 폴백
   * 렌더 경로까지 일반 메시지와 완전히 동일해야 AC2 비회귀가 성립한다(자체 폴백 div를
   * 갖지 않는 이유). */
  template: BlockTemplate;
  payload: Record<string, unknown>;
  /** story #3332 — 서버가 발행 시점에 계산한 참조 토큰({{ref.X}} 해소용). 생략(구버전 캐시
   * 등)은 undefined→{} 폴백(block-template.ts renderBlockTemplate 기본값)과 동형.
   *
   * story #3884(AC1) — `work_item` 값이 세 모양으로 넓어졌다(events.py
   * `_render_event_notification_work_item_ref`): 찾음(`{found:true, token}`)·리졸버는
   * 있는데 못 찾음(`{found:false, type}` — 삭제·조직 밖, 텍스트는 이 컴포넌트가 렌더
   * 시점에 짓는다)·리졸버 자체가 없음(키 자체 부재, agent_decision·support_escalation
   * — 구조적 부재). 예전 계약(순 문자열)도 방어적으로 남겨둔다(구버전 캐시/직접 호출부
   * 호환) — 현재 실 프리셋은 더 이상 `{{ref.X}}`를 직접 참조하지 않는다(전부
   * `labels.work_item_target` 경유, 아래).
   *
   * story #3893 — `assignee`/`assigned_by` 값은 `work_item`과 다른 두 모양(member는
   * 항상 단일 리졸버라 "리졸버 자체가 없음" 갈래가 없다, events.py
   * `_render_event_notification_member_ref`): 찾음(`{found:true, name}`)·못 찾음
   * (`{found:false}` — 텍스트는 이 컴포넌트가 렌더 시점에 짓는다). */
  refs?: Record<
    string,
    | string
    | null
    | { found: boolean; token?: string; type?: string; name?: string }
  >;
  /** story #4209 — 이 이벤트의 정의(key·org_id·name). 플랫폼 마케팅·워크플로우 프리셋이면 카드 머리말·본문·필드
   * 라벨을 로케일 문안으로 바꾼다(localizePresetBlockTemplate). 없거나 조직 정의면 템플릿 원문 그대로. */
  definition?: EventDefinitionSummary | null;
}

// story #2637 — 유나 design 스티어 2차(08-14, 재작업 방식까지 PR 前 확定).
// ⟨missing: payload.x⟩는 콘텐츠와 구분되는 「에러 상태」로 보인다 — solid text-warning-strong
// (#2594 패턴, 알파 금지) + 이탤릭. 빨강(destructive) 금지 — 치환 실패는 저자(템플릿) 실수지
// 사용자 위험이 아니다. 마커를 **먼저** 이 정규식으로 갈라내고, 인라인 마크다운(굵게/코드)은
// 마커가 아닌 조각에만 적용한다 — 순서를 바꾸면 마커 안 `payload.x`의 `_`가 이탤릭으로
// 오파싱될 위험이 있다(마커는 항상 리터럴 텍스트로 유지). renderBlockTemplate은 완성된
// 문자열을 주므로 여기서 정규식으로 다시 갈라 부분 스타일만 입힌다(block-template.ts 파서
// 자체는 순수 문자열 계약 그대로 유지 — 세그먼트 구조로 바꾸지 않는다).
// story #3332 — {{ref.X}}도 같은 "미해소=명시 마커" 원칙이라 시각적으로 동일하게 구분돼야
// 한다(payload.와 ref. 두 네임스페이스를 하나의 alternation으로).
// story #3881 — {{label.X}}(block-template.ts 3번째 네임스페이스) 신설 시 이 alternation에
// 추가를 누락하면 ⟨missing: label.x⟩가 마커 스타일(경고색+이탤릭) 없이 평문으로 새는
// 자리가 생긴다 — 실측으로 발견해 처방(뮤테이션 셀프체크: 추가 前엔 라벨 미싱 케이스가
// 스타일 없이 렌더돼 회귀).
// story #3884 — {{t.X}}(4번째 네임스페이스) 신설 시 같은 누락 위험 — alternation에 추가.
const MISSING_MARKER_RE = /(⟨missing: (?:payload|ref|label|t)\.[a-zA-Z0-9_]+⟩)/g;
// AC0-b 스펙 의도(굵게 `**…**`·코드 `` `…` ``)만 지원하는 최소 인라인 마크다운 — 그 밖의
// 마크다운 문법(링크·이탤릭 등)은 AC0-b 예시에 없어 v1 범위 밖으로 다루지 않는다.
const INLINE_MD_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

// story #3332 — {{ref.X}}가 치환하는 값은 BE `build_reference_token`과 정확히 같은 모양
// (`[제목](entity:type:id)`, escape 규칙까지 동일 — reference_token.py/mention_parser.py의
// FE 미러). 이 카드의 인라인 렌더러는 원래 **bold**/`code`만 알아서, 이 토큰을 그대로 두면
// 「대상: [제목](entity:doc:UUID)」처럼 UUID가 그대로 텍스트에 노출된다(story #2637 Q2
// "UUID 노출 금지" 위반, 실측 — chat-bubble.test.tsx 회귀로 발견).
//
// PO 리뷰(PR#3714) — 채팅·결재 dialog(#3710)·문서·스토리 패널이 전부 같은 토큰 클래스를
// `EntityChip`(embed-card.tsx SSOT)으로 그린다. 여기만 자체 `<a>`/`<span>`을 새로 짓지
// 않는다(두 벌 금지) — 토큰 span 자체를 찾는 정규식만 이 파일 몫으로 남기고(ReactMarkdown
// 없이 직접 정규식으로 훑는 소비부라 span 탐지 자체는 대체할 게 없다 — chat-bubble.tsx 등은
// ReactMarkdown이 이미 `[title](href)`를 `<a>`로 갈라 주지만 이 렌더러는 그 파서가 없다),
// href 파싱은 `parseEntityRef`(entity-ref.ts SSOT, 비-UUID는 null → 폴백)·제목 unescape는
// `unescapeReferenceLabel`(같은 SSOT 파일 — ReactMarkdown이 없는 소비부 전용)·렌더는
// `EntityChip` 그대로 재사용한다. `references` 사이드밴드가 없는 소비부라(서버가 발행
// 시점에 계산한 합성 토큰 — 유령 판정 대상 아님) `resolveEmbedDecision` 없이 embed-card.tsx
// `MdBody`의 references-less 패턴과 동형으로 ghost/referenceMeta 생략 기본값을 그대로 쓴다.
const ENTITY_TOKEN_SPAN_RE = /\[((?:[^\]\\]|\\.)*)\]\(([^)]*)\)/g;

function renderTextWithEntityTokens(text: string, withProject: (href: string) => string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  let i = 0;
  for (const m of text.matchAll(ENTITY_TOKEN_SPAN_RE)) {
    const [full, rawTitle, href] = m;
    const ref = parseEntityRef(href);
    if (!ref) continue;
    const start = m.index ?? 0;
    if (start > lastEnd) parts.push(<span key={i++}>{renderInlineMarkdown(text.slice(lastEnd, start))}</span>);
    parts.push(
      <EntityChip
        key={i++}
        entityType={ref.entityType}
        entityId={ref.entityId}
        label={unescapeReferenceLabel(rawTitle)}
        href={getEntityHref(ref.entityType, ref.entityId, withProject)}
      />,
    );
    lastEnd = start + full.length;
  }
  if (lastEnd === 0) return renderInlineMarkdown(text);
  if (lastEnd < text.length) parts.push(<span key={i++}>{renderInlineMarkdown(text.slice(lastEnd))}</span>);
  return parts;
}

// PO 리뷰(head 57316d4e7, node 재현 첨부) — 예전엔 여기 "전체가 단일 토큰"일 때 렌더를
// 건너뛰는 fast-path가 있었는데, 그 판별에 모듈 전역 /g 정규식의 .test()를 썼다. /g는
// lastIndex를 정규식 "객체"에 남기므로, 같은 렌더 패스 안에서 같은 정규식으로 연속 호출되면
// (예: fields의 두 값이 둘 다 백틱 하나짜리 완전일치) 두 번째 호출이 앞 호출이 남긴
// lastIndex부터 찾다 못 찾고 fast-path를 잘못 타 리터럴로 샜다. 고침: fast-path를 아예
// 없앤다 — split 결과의 각 조각을 그대로 매핑하면(무매치든 매치든) startsWith/endsWith
// 내용 검사만으로 충분히 정확하고, 공유 정규식 객체의 상태에 기대지 않는다.
function renderInlineMarkdown(text: string): React.ReactNode {
  const parts = text.split(INLINE_MD_RE).filter((p) => p !== '');
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{part}</span>;
  });
}

// 마커 조각 판별도 같은 이유로 .test() 재검사 대신 split 결과의 인덱스 홀짝으로 가른다 —
// 캡처 그룹 1개짜리 정규식의 split은 [평문, 매치, 평문, 매치, ...] 순서를 보장하므로
// (홀수 인덱스=캡처된 매치) 공유 정규식 객체의 lastIndex 상태와 완전히 무관하다.
function renderTextWithMissingMarkers(text: string, withProject: (href: string) => string): React.ReactNode {
  const parts = text.split(MISSING_MARKER_RE);
  if (parts.length === 1) return renderTextWithEntityTokens(text, withProject);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <em key={i} className="italic text-warning-strong">{part}</em>
      : <span key={i}>{renderTextWithEntityTokens(part, withProject)}</span>,
  );
}

/**
 * story #2637 — event_definitions.block_template v1 렌더러. 호출부(chat-bubble.tsx)가 이미
 * parseBlockTemplate로 파싱을 끝낸 template만 받는다 — 파싱 실패/정의 없음일 땐 이 컴포넌트가
 * 아예 안 불린다(AC2 비회귀는 호출부의 분기 책임).
 *
 * ⚠️ action_auth(human_only/role) 집행 — **보안 경계는 BE(publish_registry_event, definition-
 * level 검사 — story #2637 §범위3/#3037, PO 08-14 확定)에 있다.** 이 컴포넌트의 «권한 없어
 * 보이면 숨김/문구» 표시는 UX 안내일 뿐이다 — REST를 직접 때리면 이 UI를 거치지 않고도
 * 도달할 수 있어(2091과 동형 클래스), 여기서 버튼을 숨겼다고 그게 실 차단이라고 오인하면
 * 안 된다. 실 거부는 BE가 403 `{code:"action_auth_denied", message}`로 내려준다(아래
 * EventPublishActionButton의 catch가 그 message를 그대로 보여준다 — FE가 재구성 안 함).
 *
 * role 축 의미(#3037 리뷰 기록, 2026-08-14): `action_auth.role`은 **조직 role**(member/
 * admin/owner — team_members.role, `/api/me`가 내려주는 그 값)이다. 직무 템플릿 slug(예:
 * "backend-engineer")가 아니다 — 이름이 비슷해 헷갈리기 쉬운 축이라 명시한다.
 */
export function EventBlockCard({ template, payload, refs, definition }: EventBlockCardProps) {
  const t = useTranslations('chats');
  const tBoard = useTranslations('board');
  const tCage = useTranslations('cage');
  const tDashboard = useTranslations('dashboard');
  const tOrg = useTranslations('organization');
  const tEventCard = useTranslations('eventCard');
  const tOutcomeLoop = useTranslations('outcomeLoop');
  const tHypotheses = useTranslations('hypotheses');
  const tPreset = useTranslations('recipePreset');
  const locale = useLocale();
  const { currentMemberType, role, orgId } = useDashboardContext();
  // story #3287(도메인탈고정) — org 커스텀 status 라벨 오버라이드. statusLabel()이 undefined면
  // (오버라이드 미설정) 아래에서 canonical i18n(STORY_STATUS_KEY_MAP→tBoard)으로 폴백한다 —
  // kanban-board.tsx 등 기존 소비처와 동일 3단 폴백(org 커스텀 → canonical i18n → 원시 slug).
  const domainLabels = useOrgDomainLabels(orgId, locale);

  // story #3881(customer-zero, PO 確定 2026-09-14) — preset.work.status_changed/
  // preset.gate.verdict가 원시 slug(from_status/to_status/verdict/work_item_type/
  // gate_type)를 payload로 실어 보내면 그 값은 발행 시점에 고정돼(en 사용자·org 커스텀
  // 라벨과 안 맞음) 렌더 시점에 해석해야 한다 — block-template.ts는 순수 함수라 t()를
  // 못 쓰므로, 이 호출부가 미리 계산해 `{{label.X}}` 네임스페이스로 넘긴다(ref와 동형
  // 패턴). payload에 해당 키가 없으면(다른 preset이라 무관) labels에도 안 실어 — 그
  // 템플릿에 `{{label.X}}` 자체가 없으니 무해.
  const labels: Record<string, string> = {};
  for (const key of ['from_status', 'to_status'] as const) {
    const slug = payload[key];
    if (typeof slug !== 'string') continue;
    const statusKey = STORY_STATUS_KEY_MAP[slug];
    labels[key] = domainLabels.statusLabel(slug) ?? (statusKey ? tBoard(statusKey) : slug);
  }
  const verdict = payload['verdict'];
  if (typeof verdict === 'string') {
    labels['verdict'] = gateStatusLabel(verdict, tCage);
  }
  // 페드루 CHANGES(2026-09-14 15:26Z) — 캡처 리뷰로 실측 적출: work_item_type("story")·
  // gate_type("external_publish" 등)도 같은 클래스의 원시 slug였다(AC2 "slug 0"과 동일
  // 원칙). 기존 SSOT 재사용(새 매핑 0) — entityTypeLabel()(chat-input-entity-tokens.ts,
  // §②-1 낱말 표와 정합)·gateTypeLabel()(lib/gate-type-label.ts, dashboard 네임스페이스).
  const workItemType = payload['work_item_type'];
  if (typeof workItemType === 'string') {
    labels['work_item_type'] = entityTypeLabel(workItemType, t);
  }
  const gateType = payload['gate_type'];
  if (typeof gateType === 'string') {
    labels['gate_type'] = gateTypeLabel(tDashboard, gateType);
  }
  // story #4086 — 레시피 사이클형 정의(preset.marketing.video_production 등)의 단계
  // 알림이 raw stage slug("draft" 등)를 그대로 노출했다. recipe-stage-label.ts(story
  // #4049/#4082, 스토리 패널·결재함·게이트 상세 3표면이 이미 쓰는 그 SSOT — 두 번째
  // 사전 0)로 해소 — 미등재 slug는 원시값 그대로(지어내지 않음, 기존 recipeStageLabel
  // pass-through 계약 그대로).
  const stage = payload['stage'];
  if (typeof stage === 'string') {
    labels['stage'] = recipeStageLabel(stage, tOrg);
  }

  // story #3884 AC1 — refs.work_item(events.py의 세 모양)을 labels.work_item_target으로
  // 미리 해석한다. 찾음=토큰 문자열 그대로(EntityChip 렌더는 renderTextWithEntityTokens가
  // 최종 문자열만 보고 판별하므로 namespace 무관 — 새 렌더 기전 0) / 리졸버는 있는데 못
  // 찾음=은은한 targetMissing 문구(fail-loud ⟨missing:…⟩ 마커와 다른 층 — PO 확定,
  // «리졸버가 돌았고 엔티티가 삭제됨»은 알려진 상태라 조용히) / 리졸버 자체가 없음(refs.
  // work_item 키 자체 부재)=labels 키를 안 채워 block-template.ts의 기존 optional elision
  // 이 그 field entry를 줄 생략시킨다(새 메커니즘 0).
  const workItemRef = refs?.['work_item'];
  if (typeof workItemRef === 'string') {
    // 구계약(순 문자열) 방어적 호환 — 현재 실 publisher는 이 모양을 안 낸다.
    labels['work_item_target'] = workItemRef;
  } else if (workItemRef && typeof workItemRef === 'object') {
    if (workItemRef.found && typeof workItemRef.token === 'string') {
      labels['work_item_target'] = workItemRef.token;
    } else if (!workItemRef.found && typeof workItemRef.type === 'string') {
      // 유나 §⑤ 표(doc a699be00, 3884 절) — en targetMissing만 소문자로(entityTypeLabel en
      // 값은 "Story"류 대문자라, 이 문장 중간 자리에선 소문자가 맞다 — "(deleted Story)"
      // 아니라 "(deleted story)"). ko는 대소문자 구분이 없어 toLowerCase()가 no-op이라
      // 로케일 분기 없이 안전하게 항상 적용한다.
      labels['work_item_target'] = tEventCard('targetMissing', {
        type: entityTypeLabel(workItemRef.type, t).toLowerCase(),
      });
    }
  }

  // story #3893(PO 確定 2026-09-14) — refs.assignee/refs.assigned_by(events.py
  // `_render_event_notification_member_ref`의 두 모양)를 labels.assignee_name/
  // assigned_by_name으로 미리 해석한다. work_item_target과 동형 원칙이되 member는
  // "리졸버 자체가 없음" 갈래가 없다(항상 단일 리졸버) — 찾음=이름 그대로 / 못 찾음=
  // 은은한 assigneeMissing 문구(fail-loud ⟨missing:…⟩ 마커와 다른 층, targetMissing과
  // 동일 원칙) / refs 키 자체 부재(해당 preset이 아님)=labels 키 미설정→optional
  // elision.
  for (const [refsKey, labelKey] of [
    ['assignee', 'assignee_name'],
    ['assigned_by', 'assigned_by_name'],
  ] as const) {
    const memberRef = refs?.[refsKey];
    if (memberRef && typeof memberRef === 'object') {
      if (memberRef.found && typeof memberRef.name === 'string') {
        labels[labelKey] = memberRef.name;
      } else if (!memberRef.found) {
        labels[labelKey] = tEventCard('assigneeMissing');
      }
    }
  }

  // story #3893 CHANGES②(PO PR#4298 리뷰 2026-09-15) — refs.goal(preset.goal.measured의
  // goal_id, 실은 epic.id — events.py `_render_event_notification_work_item_ref`의
  // "epic" 갈래 재사용, work_item_target과 완전 동형 3모양 계약)을 labels.goal_target으로.
  const goalRef = refs?.['goal'];
  if (goalRef && typeof goalRef === 'object') {
    if (goalRef.found && typeof goalRef.token === 'string') {
      labels['goal_target'] = goalRef.token;
    } else if (!goalRef.found && typeof goalRef.type === 'string') {
      labels['goal_target'] = tEventCard('targetMissing', {
        type: entityTypeLabel(goalRef.type, t).toLowerCase(),
      });
    }
  }

  // story #3893 CHANGES①(PO PR#4298 리뷰 2026-09-15) — metric_unit은 「%」 같은 단위
  // 기호가 아니라 metric **이름**이다(completion_pct·GA4 임의 문자열 — outcome_scorer.py
  // 그라운딩). outcomeLoop 네임스페이스의 기존 `metric_{slug}` 낱말(outcome-intent-
  // fields.tsx가 이미 씀, 신규 어간 0)을 재사용해 등재 4종만 번역하고, 미등재(GA4 임의
  // 값 등)는 라벨을 아예 안 채워 optional 필드 자체를 생략한다(raw slug 노출 방지 —
  // 지어내지 않는다 원칙, targetMissing류 은은한 폴백조차 없음: "번역 불가능한 임의
  // 문자열"은 «삭제됨» 같은 알려진 상태가 아니라 그냥 노출하지 않는 게 맞다).
  const metricUnit = payload['metric_unit'];
  if (typeof metricUnit === 'string' && (METRIC_UNIT_KEYS as readonly string[]).includes(metricUnit)) {
    labels['metric_unit_label'] = tOutcomeLoop(`metric_${metricUnit}` as 'metric_velocity');
  }

  // story #3893 CHANGES③ — measured_at(ISO 8601)을 lib/i18n.ts::formatLocaleDateTime
  // (기존 Intl 포매터, 신규 로직 0)로 렌더 시점 로케일 포맷. 파싱 실패(빈 문자열 반환,
  // formatLocaleDate의 기존 계약)는 labels 키를 안 채워 optional 생략.
  const measuredAtRaw = payload['measured_at'];
  if (typeof measuredAtRaw === 'string') {
    const formatted = formatLocaleDateTime(measuredAtRaw, locale);
    if (formatted) labels['measured_at'] = formatted;
  }

  // story #3893 CHANGES(PO PR#4298 2차 리뷰 2026-09-15) — source(raw slug "internal_ops"/
  // "ga4")를 hypotheses.sourceInternal/sourceGa4 기존 낱말로. 미등재는 optional 생략
  // (metric_unit과 동일 원칙).
  const source = payload['source'];
  if (typeof source === 'string' && source in SOURCE_LABEL_KEYS) {
    labels['source_label'] = tHypotheses(SOURCE_LABEL_KEYS[source]!);
  }

  // story #3884 AC2 — preset.gate.verdict 본문 접속어. PO 구조 결정: 리터럴 「게이트」를
  // 없애고(미등재 gate_type이 ccGateGeneric 「게이트」 폴백일 때 헤더 "게이트 판정"과
  // 겹쳐 "게이트 게이트 — …"로 이중 인쇄되는 잠재 결함 해소) gateType/verdict 두 라벨만
  // 남긴다. next-intl ICU 단일 중괄호 보간(tEventCard 호출 자체)과 이 파일의 이중 중괄호
  // {{label.X}} mustache는 서로 다른 계층 — 여기서 완성 문자열로 미리 조립해 labels에
  // 싣는다(block-template.ts는 여전히 순수 함수).
  if (typeof labels['gate_type'] === 'string' && typeof labels['verdict'] === 'string') {
    labels['gate_connective_line'] = tEventCard('gateConnective', {
      gateType: labels['gate_type'],
      verdict: labels['verdict'],
    });
  }

  // story #3884 AC2 — 헤더·필드 라벨(예: {{t.targetLabel}})은 payload와 무관한 고정 UI
  // 카피라 `label`과 다른 네임스페이스(`t`)로 렌더 시점에 해석한다(eventCard 낱말 표,
  // 유나 확定 2026-09-14 16:02Z·doc a699be00). 현재 프리셋이 실제로 참조하는 키만
  // 나열(신규 키 추가 시 여기도 같이 넓혀야 렌더에 반영된다).
  const translations: Record<string, string> = {
    statusChangedHeader: tEventCard('statusChangedHeader'),
    gateVerdictHeader: tEventCard('gateVerdictHeader'),
    targetLabel: tEventCard('targetLabel'),
    noteLabel: tEventCard('noteLabel'),
    reasonLabel: tEventCard('reasonLabel'),
    // story #3893
    workAssignedHeader: tEventCard('workAssignedHeader'),
    goalMeasuredHeader: tEventCard('goalMeasuredHeader'),
    assigneeLabel: tEventCard('assigneeLabel'),
    assignedByLabel: tEventCard('assignedByLabel'),
    goalLabel: tEventCard('goalLabel'),
    unitLabel: tEventCard('unitLabel'),
    sourceLabel: tEventCard('sourceLabel'),
    metricValueLabel: tEventCard('metricValueLabel'),
    measuredAtLabel: tEventCard('measuredAtLabel'),
  };

  // story #3884 — 현재 실 프리셋(status_changed·gate.verdict)은 더 이상 `{{ref.X}}`를
  // 템플릿에서 직접 참조하지 않는다(work_item이 유일 종류였고 label 경유로 옮겨갔다, 위
  // workItemRef 처리). 하지만 `{{ref.X}}` 자체(story #3332 일반 메커니즘)는 여전히
  // 살아 있어야 한다 — 구버전 캐시·org 커스텀 오버라이드가 아직 예전 계약(`{{ref.
  // work_item}}` 직접 참조, 순 문자열 값)을 쓸 수 있다. 그래서 refs를 그대로 버리지
  // 않고, 순 문자열(구계약)만 골라 renderBlockTemplate의 refs 인자로 넘긴다 — 새 dict
  // 모양(found/type)은 'ref' 네임스페이스가 기대하는 값이 아니므로(labels.
  // work_item_target으로 이미 소비했다) 여기선 제외한다.
  const refsForTemplate: Record<string, string | null> = {};
  if (refs) {
    for (const [key, value] of Object.entries(refs)) {
      if (typeof value === 'string' || value === null) refsForTemplate[key] = value;
    }
  }
  // story #4209(유나 확정) — 플랫폼 마케팅·워크플로우 프리셋은 시드 block_template(한 언어·옛 이름·합니다체·워크플로우는
  // stage slug 원문)을 로케일 문안으로: 머리말 «{이름} 워크플로우» · 본문 «**{단계 라벨}** 단계로 넘어갔어요» · «대상» 필드
  // 라벨. 조직 정의·정의 모름은 원문 그대로(isLocalizedPlatformPreset).
  const localizedTemplate = isLocalizedPlatformPreset(definition)
    ? localizePresetBlockTemplate(template, definition, {
      header: tPreset('headerTemplate', { name: presetName(definition, tPreset) }),
      body: typeof labels['stage'] === 'string' ? tPreset('stageMovedBody', { stage: labels['stage'] }) : null,
      targetLabel: tEventCard('targetLabel'),
    })
    : template;
  const blocks = renderBlockTemplate(localizedTemplate, payload, refsForTemplate, labels, translations);

  return (
    <div className="min-w-0 max-w-full space-y-3 rounded-xl rounded-tl-sm border border-border bg-card px-3.5 py-3">
      {blocks.map((block, i) => (
        <EventBlockRow
          key={i}
          block={block}
          payload={payload}
          currentMemberType={currentMemberType}
          currentRole={role}
          t={t}
        />
      ))}
    </div>
  );
}

function isActionAuthorized(
  auth: { human_only?: boolean; role?: string[] } | undefined,
  currentMemberType: 'human' | 'agent' | undefined,
  currentRole: string | undefined,
): boolean {
  if (!auth) return true;
  if (auth.human_only && currentMemberType !== 'human') return false;
  if (auth.role && auth.role.length > 0 && (!currentRole || !auth.role.includes(currentRole))) return false;
  return true;
}

/**
 * story #2637 AC4 — header/text/fields 3종(비-action)만 그린다. approval-request-card.tsx가
 * preset.gate.verdict 템플릿을 「부분 소비」할 때 재사용한다(actions는 그쪽 카드가 자기 고유의
 * 서명/버튼 분기를 유지하므로 여기서 다루지 않는다 — null 반환, 호출부가 filter로 걸러도 되고
 * 안 걸러도 안전). EventBlockCard와 approval-request-card 둘 다 이 함수로 동일한 시각 어휘를
 * 공유한다(DS 원칙 "동일 개념=동일 어휘" — 사본 분화 금지).
 */
/** withProject — 본문 엔티티 칩(문서 · flat)에 프로젝트를 싣는 함수(story #4231 3차 · 필수). 호출처 컴포넌트는 useFlatHref()를 넘긴다. */
export function renderStaticEventBlock(block: BlockTemplateBlock, key: number, withProject: (href: string) => string): React.ReactNode {
  // story #2637 — 유나 design 스티어: 4블록 시각 위계(header 최상위 > fields 구조데이터 >
  // text 본문 > actions 하단 액션열) — 렌더 «순서»는 템플릿 저자가 선언한 그대로 따르되
  // (임의 재배열 안 함), 각 블록 타입의 폰트 크기/굵기로 위계만 표현한다.
  if (block.type === 'header') {
    return <p key={key} className="text-base font-semibold text-foreground">{renderTextWithMissingMarkers(block.text, withProject)}</p>;
  }
  if (block.type === 'text') {
    return <p key={key} className="text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{renderTextWithMissingMarkers(block.text, withProject)}</p>;
  }
  if (block.type === 'fields') {
    return (
      <dl key={key} className="space-y-1.5 rounded-lg bg-muted/40 px-2.5 py-2">
        {block.fields.map((f, i) => (
          <div key={i} className="flex gap-2 text-xs">
            <dt className="shrink-0 font-medium text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{renderTextWithMissingMarkers(f.value, withProject)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function EventBlockRow({
  block, payload, currentMemberType, currentRole, t,
}: {
  block: BlockTemplateBlock;
  payload: Record<string, unknown>;
  currentMemberType: 'human' | 'agent' | undefined;
  currentRole: string | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  const flatHref = useFlatHref(); // story #4231 3차 — 본문 엔티티 칩(문서 · flat)은 현재 프로젝트를 싣는다
  if (block.type !== 'actions') {
    return renderStaticEventBlock(block, 0, flatHref);
  }
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      {block.actions.map((a, i) => {
        const authorized = isActionAuthorized(a.auth, currentMemberType, currentRole);
        return (
          <EventPublishActionButton
            key={i}
            label={a.label}
            definitionKey={a.definition_key}
            payload={payload}
            authorized={authorized}
            t={t}
          />
        );
      })}
    </div>
  );
}

function EventPublishActionButton({
  label, definitionKey, payload, authorized, t,
}: {
  label: string;
  definitionKey: string;
  payload: Record<string, unknown>;
  authorized: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authorized) {
    // story #2637 유나 design 스티어 — "무음 회색 버튼만 두지 말 것": 비활성 상태를 실제
    // disabled 버튼으로 보여주고(어떤 액션이 막혔는지 시각적으로 남김) 바로 옆에 왜 막혔는지
    // 보조문구를 둔다(호버 전제인 툴팁 단독 대신 — 터치 기기에서도 항상 보임).
    return (
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled title={t('eventActionUnauthorized')}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          {label}
        </Button>
        <p className="text-[11px] text-muted-foreground">{t('eventActionUnauthorized')}</p>
      </div>
    );
  }
  if (published) {
    return (
      <p className="flex items-center gap-1 text-[11px] font-medium text-foreground">
        <Send className="h-3 w-3" aria-hidden />
        {t('eventActionPublished')}
      </p>
    );
  }

  const handleClick = async () => {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch('/api/events/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition_key: definitionKey, payload }),
      });
      if (!res.ok) {
        // story #2637 §범위3/#3037 — 403 action_auth_denied는 BE가 이유를 완성 문장으로
        // 주므로(예: "이 이벤트(...)는 human 발행자만 허용합니다") FE가 재구성하지 않고
        // 그대로 보여준다(BE가 실 권위이자 유일한 메시지 출처). story #2647에서
        // extractBackendErrorMessage로 공통화(DeliveryContractModal과 동형 패턴 공유).
        const body = await res.json().catch(() => null);
        const msg = extractBackendErrorMessage(body, t) ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setPublished(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('eventActionPublishFailed'));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" onClick={() => void handleClick()} disabled={publishing}>
        <Send className="h-3.5 w-3.5" aria-hidden />
        {label}
      </Button>
      {error && (
        <p role="alert" aria-live="assertive" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface EventPreviewHelpers {
  tBoard: (key: string) => string;
  tCage: (key: string) => string;
  tDashboard: (key: string) => string;
  tEventCard: (key: string) => string;
  tEntity: (key: string) => string;
  /** story #3893 CHANGES①(PO PR#4298 리뷰) — metric_unit(metric 이름, 「%」 아님) 매핑용,
   * event-block-card.tsx의 METRIC_UNIT_KEYS 닫힌 집합과 동형 재사용. */
  tOutcomeLoop: (key: string) => string;
  domainLabels: { statusLabel: (slug: string) => string | undefined };
}

/**
 * story #3888(§⑤·Chat, PO 확定 2026-09-14 18:19Z) — 대화 목록 미리보기(chat-list-view.tsx)
 * 가 이벤트 메시지의 raw content(발행 시점에 구운 「[이벤트] preset.gate.verdict」류
 * slug — backend/app/routers/events.py의 `_render_gate_verdict_message` 등)를 그대로
 * 보여주던 것을 막는다. 이 파일의 헤더/필드 라벨 해석 재료(gateTypeLabel·gateStatusLabel·
 * entityTypeLabel·STORY_STATUS_KEY_MAP·domainLabels)로 "{헤더} · {요약}" 한 줄만
 * 조립한다(PO 예: "게이트 판정 · 외부 발행 — 승인됨"·"작업 상태 변경 · 스토리 개발 대기
 * → 진행 중") — EventBlockCard 전체(다중 블록) 렌더 재사용이 아니라 그 안의 "헤더+한 줄
 * 요약" 재료만 재사용(새 낱말 0, 새 라벨 해석 로직 0). gateConnective i18n 키는 여기서
 * 안 쓴다 — 그 값이 ChatMarkdown용 `**bold**` 마크다운을 품고 있어(block-template 렌더
 * 전용) 순수 텍스트 리스트 행에 쓰면 별표(`**`)가 그대로 샌다.
 *
 * 현재 이 4 preset만 처리(gate.verdict·work.status_changed — PO가 실측한 사고 자리,
 * story #3893으로 work.assigned·goal.measured 추가) — 다른 event_key·필수 payload
 * 필드 부재(work.assigned는 refs.assignee 미해소 포함)는 null을 돌려줘 호출부가 기존
 * content 폴백으로 떨어진다(과잉 일반화 금지, 발명 0).
 */
export function composeEventPreviewLine(
  eventKey: string | undefined,
  payload: Record<string, unknown> | undefined,
  helpers: EventPreviewHelpers,
  // story #3893(PO 確定 2026-09-14) — preset.work.assigned 미리보기가 담당자 이름을
  // 실으려면 BE가 발행 시점에 계산한 refs(assignee)가 필요하다(work_item_target과
  // 동형 원칙 — FE가 매 행마다 멤버 조회 API를 새로 부르면 CHANGES①(useOrgDomainLabels
  // 행별 중복요청 제거)이 막은 것과 같은 N+1 클래스가 된다). msg_metadata['event']에
  // 이미 실려 있다(_event_payload()가 additive로 그대로 투영, BE 스키마 변경 0 —
  // 그라운딩 확認: _publish_registry_event_core가 event_context 전체를 msg_metadata에
  // 저장하고 그 dict가 이미 refs를 포함).
  refs?: Record<string, string | null | { found: boolean; token?: string; type?: string; name?: string }>,
): string | null {
  if (!eventKey || !payload) return null;
  const { tBoard, tCage, tDashboard, tEventCard, tEntity, tOutcomeLoop, domainLabels } = helpers;

  if (eventKey === 'preset.gate.verdict') {
    const gateType = payload['gate_type'];
    const verdict = payload['verdict'];
    if (typeof gateType !== 'string' || typeof verdict !== 'string') return null;
    const gateTypeLbl = gateTypeLabel(tDashboard, gateType);
    const verdictLbl = gateStatusLabel(verdict, tCage);
    return `${tEventCard('gateVerdictHeader')} · ${gateTypeLbl} — ${verdictLbl}`;
  }

  if (eventKey === 'preset.work.status_changed') {
    const fromStatus = payload['from_status'];
    const toStatus = payload['to_status'];
    if (typeof fromStatus !== 'string' || typeof toStatus !== 'string') return null;
    const resolveStatusLabel = (slug: string) => {
      const statusKey = STORY_STATUS_KEY_MAP[slug];
      return domainLabels.statusLabel(slug) ?? (statusKey ? tBoard(statusKey) : slug);
    };
    const fromLabel = resolveStatusLabel(fromStatus);
    const toLabel = resolveStatusLabel(toStatus);
    const workItemType = payload['work_item_type'];
    const typeLabel = typeof workItemType === 'string' ? entityTypeLabel(workItemType, tEntity) : null;
    const summary = typeLabel ? `${typeLabel} ${fromLabel} → ${toLabel}` : `${fromLabel} → ${toLabel}`;
    return `${tEventCard('statusChangedHeader')} · ${summary}`;
  }

  // story #3893(유나 §⑤ 확定 2026-09-14 19:47Z) — "작업 배정 · {work_item_type 라벨} →
  // {담당자 이름}"(예 "작업 배정 · 스토리 → 미르코"). 담당자 미해소(refs.assignee 없음/
  // found:false)는 다른 필수 필드 부재와 동일하게 null(과잉 일반화 금지 — 이 preset은
  // 담당자 없이는 문장이 성립하지 않는다, work_item_type/verdict 부재 시 null과 동형).
  if (eventKey === 'preset.work.assigned') {
    const workItemType = payload['work_item_type'];
    const typeLabel = typeof workItemType === 'string' ? entityTypeLabel(workItemType, tEntity) : null;
    const assigneeRef = refs?.['assignee'];
    const assigneeName =
      assigneeRef && typeof assigneeRef === 'object' && assigneeRef.found && typeof assigneeRef.name === 'string'
        ? assigneeRef.name
        : null;
    if (!typeLabel || !assigneeName) return null;
    return `${tEventCard('workAssignedHeader')} · ${typeLabel} → ${assigneeName}`;
  }

  // story #3893(유나 §⑤ 확定 「목표 측정 · {metric_value}{metric_unit}」) — CHANGES①(PO
  // PR#4298 리뷰 2026-09-15)로 metric_unit 해석 그라운딩 정정: 원 문구는 metric_unit을
  // 「%」류 단위 기호로 가정했으나 실 값은 metric **이름**(completion_pct·GA4 임의
  // 문자열, outcome_scorer.py 그라운딩) — outcomeLoop.metric_{slug} 낱말(기존 재사용,
  // 신규 어간 0)로 등재 4종만 매핑하고 미등재는 값만("목표 측정 · 12", raw slug 0).
  // 등재분은 라벨 자체가 단위 기호를 품고 있어(예: 「완료율 %」) 공백으로 접합한다
  // (metric_unit이 진짜 기호였을 때의 접미 접합과 다른 합성 — 그 가정 자체가 틀렸다).
  if (eventKey === 'preset.goal.measured') {
    const metricValue = payload['metric_value'];
    if (metricValue === undefined || metricValue === null || metricValue === '') return null;
    const metricUnit = payload['metric_unit'];
    const unitLabel =
      typeof metricUnit === 'string' && (METRIC_UNIT_KEYS as readonly string[]).includes(metricUnit)
        ? tOutcomeLoop(`metric_${metricUnit}` as 'metric_velocity')
        : null;
    const summary = unitLabel ? `${metricValue} ${unitLabel}` : `${metricValue}`;
    return `${tEventCard('goalMeasuredHeader')} · ${summary}`;
  }

  return null;
}
