'use client';

import { useEffect, useState } from 'react';
import { FileText, MessageSquare, Calendar, BookOpen, ClipboardCheck, Frame } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { pickEunNeunJosa } from '@/lib/korean-particle';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { fetchWithAuth } from '@/lib/db/client';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { stageRoleLabel } from '@/lib/stage-role';
import { gateApproverLabel } from '@/lib/gate-approver-label';
import { toPlainPreview } from '@/components/chat/entity-ref';

interface BacklinkMember { id: string; name: string; type: string }

// export: story #2267(C-9) — story-origin-section.tsx가 같은 응답 형상을 소비한다(출처는
// 이 목록과 같은 엔드포인트·같은 item 형상, relation 축으로만 갈린다).
export interface BacklinkItem {
  id: string;
  // story #2267(C-9): meeting·story도 source가 될 수 있다(backend/app/services/backlinks.py
  // 동반 확장) — doc·chat_message 둘뿐이던 것에서 넓어짐. story #4141: evidence·artifact도
  // source가 된다(entity_references 온보딩 — 이 전엔 이 체계가 evidence/artifact를 아예
  // 못 셌다).
  source_type: 'chat_message' | 'doc' | 'meeting' | 'story' | 'evidence' | 'artifact';
  source_id: string;
  created_by: BacklinkMember | null;
  created_at: string;
  /** story #2267(C-9): 'none'(본문 참조) · 'created_from'(target이 이 source에서 만들어졌다
   * — "출처"). ⛔컨테이너(epic/sprint/meeting_id)와 이 값을 화면에서 섞지 않는다(AC4) —
   * relation==='created_from'인 항목은 story-origin-section.tsx가 별도로 그리므로 이 목록
   * (「이것을 가리키는 것들」)에서는 제외한다(아래 mentionItems). */
  relation: 'none' | 'created_from';
  still_exists: boolean;
  doc: { id: string; title: string } | null;
  message: {
    id: string; conversation_id: string; content_snippet: string; sender: BacklinkMember | null;
    /** story #4091(E-RECIPE-1 팔로우업, PO 확定 2026-09-21 §c) — 이 메시지가 이벤트 발행
     * 메시지(story #2637 AC 0-a)면 content_snippet 원문(agent 채널 전용 raw stage/approver
     * — events.py `_render_event_message_content` docstring 참조) 대신 이 구조화 필드로
     * recipe-stage-label.ts/gate-approver-label.ts(#4464) SSOT 재구성 렌더를 쓴다.
     * role/gate_type/approver/name은 BE가 정의를 못 찾으면(삭제 등) 지어내지 않고 null. */
    event: {
      definition_key: string; name: string | null; stage: string;
      role: string | null; gate_type: string | null; approver: string | null;
    } | null;
  } | null;
  meeting: { id: string; title: string } | null;
  story: { id: string; title: string } | null;
  // story #4141 — evidence는 title이 없어(자유문자열 ref로 대체) BE가 title 자리에 ref를
  // 싣는다(backend/app/services/backlinks.py::_SIMPLE_SOURCE_TYPE_SPECS의 evidence
  // title_col=Evidence.ref 주석 참조). BE 응답은 이 두 키를 항상 싣지만(response_key
  // 초기화 루프가 5종 전부 None으로 깐다), 옵셔널로 선언해 이 필드 신설 前에 쓰인 기존
  // 픽스처(story-origin-section.test.tsx 등)를 건드리지 않는다 — 소비부는 항상 `?.`로
  // 읽으므로 undefined/null 구분이 무해하다.
  evidence?: { id: string; title: string } | null;
  artifact?: { id: string; title: string } | null;
}

const SOURCE_TYPE_ICON = {
  doc: FileText,
  chat_message: MessageSquare,
  meeting: Calendar,
  story: BookOpen,
  evidence: ClipboardCheck,
  artifact: Frame,
} as const satisfies Record<BacklinkItem['source_type'], unknown>;

/** story #4091(§c) — 이벤트 발행 메시지의 구조화 필드를 recipe-stage-label.ts/stage-role.ts/
 * gate-approver-label.ts(#4464) SSOT로 재구성한다. name이 없으면(정의 삭제 등) definition_key
 * 원문으로 물러난다(raw이긴 하지만 machine key가 사람 낱말보다 나은 유일한 폴백 — 지어내지
 * 않는다는 원칙 그대로). gate_type이 있을 때만(그 stage에 실제로 게이트가 걸릴 때만) 승인자
 * 세그먼트를 덧붙인다 — #4076이 처방한 _render_event_message_content의 "게이트 있을 때만
 * approver를 말한다" 관례와 동형. */
function eventBacklinkLabel(event: NonNullable<BacklinkItem['message']>['event'], tOrg: (key: string) => string): string {
  const name = event!.name ?? event!.definition_key;
  const stage = recipeStageLabel(event!.stage, tOrg);
  const role = event!.role ? ` (${stageRoleLabel(event!.role, tOrg)})` : '';
  const approver = event!.gate_type ? ` · ${gateApproverLabel(tOrg, event!.approver)}` : '';
  return `${name} · ${stage}${role}${approver}`;
}

function backlinkLabel(item: BacklinkItem, tOrg: (key: string) => string): string | undefined {
  switch (item.source_type) {
    case 'doc': return item.doc?.title;
    // story #3949 — content_snippet은 메시지 원문 조각이라 마크다운 링크/entity 참조
    // 토큰이 그대로 실릴 수 있다(본문 칩 렌더러를 거치지 않는 자리라 평문화 필요) —
    // #4091의 event 구조화 렌더 분기는 그대로 두고, 그 분기가 아닐 때(raw
    // content_snippet 폴백)만 평문화를 적용한다.
    case 'chat_message':
      if (item.message?.event) return eventBacklinkLabel(item.message.event, tOrg);
      return item.message?.content_snippet != null ? toPlainPreview(item.message.content_snippet) : undefined;
    case 'meeting': return item.meeting?.title;
    case 'story': return item.story?.title;
    case 'evidence': return item.evidence?.title;
    case 'artifact': return item.artifact?.title;
  }
}

interface CollectionScope {
  source_types: string[];
  forms: string;
  excludes: string[];
}

interface BacklinksMeta {
  collection_scope?: CollectionScope;
}

/** excludes 코드 → i18n 키. BE가 사실만 주고 문안은 FE 몫(collection_scope 주석 그대로).
 * story #4141 — evidence_free_text_reference는 BE가 더는 안 보낸다(evidence가 이제
 * 정식 source_type이라 이 exclude 사유 자체가 소멸 — backlinks.py::list_entity_backlinks
 * 응답 참조). 소비처 0인 키를 죽은 채 남기지 않는다(i18n 키=소비처 1:1 규율). */
const EXCLUDE_LABEL_KEYS: Record<string, string> = {
  pr_sid_text_convention: 'backlinksExcludePrSid',
};

// story #4096(리허설 1호 실측, 2026-09-21) — collection_scope.source_types 코드(BE
// app/services/backlinks.py::BACKLINKS_ALLOWED_SOURCE_TYPES, 4종 고정)가 EXCLUDE_LABEL_KEYS
// 와 달리 사람 낱말 매핑 없이 원문 그대로(«source=chat_message» 등) 화면에 샜다 — 같은
// 패턴(코드→i18n 키 조회 테이블)으로 처방. 매핑에 없는 코드(향후 BE가 늘릴 경우)는 excludes와
// 동일 원칙으로 원문 코드 그대로(번역 키 오조회 대신 "정상 경로").
const SOURCE_TYPE_LABEL_KEYS: Record<string, string> = {
  chat_message: 'backlinksSourceChatMessage',
  doc: 'backlinksSourceDoc',
  meeting: 'backlinksSourceMeeting',
  story: 'backlinksSourceStory',
  evidence: 'backlinksSourceEvidence',
  artifact: 'backlinksSourceArtifact',
};

/** BacklinksEntityType → BE 라우트 세그먼트. 불규칙복수(story→stories)라 순수 접미사 파생이
 * 아닌 조회 테이블로 연다 — PROJECT_ID_RESOLVERS와 같은 성격(종류-분기가 아니라 표기 파생).
 *
 * ⛔이 맵의 키 집합은 BE `backlinks.py::BACKLINKS_ALLOWED_TARGET_TYPES`(story #2721부터
 * `frozenset({"doc", "story", "artifact"})`)와 **글자 그대로 같은 집합**이어야 한다 — 미리
 * 늘리지 않는다. epic 등 나머지 registry 타입이 거기 없는 이유는 "라우트가 없어서"가 아니라
 * 그 라우터들에 `_require_doc_project_access`/`_assert_story_project_access`와 동형인 TARGET
 * project-access 선-게이트가 아직 없어서다(PO 확認, 2026-07-28) — 게이트 없이 여기 먼저
 * 추가하면 화면이 "게이트 없는 라우트"를 부르게 된다. artifact는 story #2721이 그 동형 게이트
 * (`_get_artifact_or_404`, 기존 project-access 계약 재사용)를 세운 뒤 여기 추가한 것.
 *
 * ⛔이 맵은 **임시**다 — BE가 언젠가 client 입력을 받는 단일 generic
 * `/entities/{type}/{id}/backlinks` 라우트로 접으면(PO가 `UnsupportedBacklinkTargetTypeError`
 * 리뷰에 미리 남겨둔 방향) 이 맵은 통째로 지운다(entity_type을 그대로 세그먼트로 쓰면 되므로).
 *
 * ⛔`Record<string, string>`으로 선언하면 `keyof`가 `string`으로 넓어져 타입가드가 이름만 있고
 * 실제로는 아무것도 안 막는다(`entityType="epic"`이 컴파일을 그냥 통과해 `/api/undefined/...`로
 * 나갈 수 있었던 자리, PO 지적) — `as const satisfies`로 좁혀 `BacklinksEntityType`이 실제로
 * `'story' | 'doc'` 리터럴 유니온이 되게 한다. */
const ENTITY_ROUTE_SEGMENT = {
  story: 'stories',
  doc: 'docs',
  artifact: 'visual-artifacts',
  // story #2889(S2h①, 페드루 확定 2026-08-21) — BE BACKLINKS_ALLOWED_TARGET_TYPES와 집합
  // 파리티(entity-backlinks-section.route-map.test.ts가 코드스캔으로 고정). gate/
  // pull_request는 아직 상세 라우트 소비처가 없다(미르코 S2d gate 프리뷰 side-pane 축과
  // 어긋나지 않게 좁게: 이 맵은 fetch 세그먼트일 뿐 화면 링크 목적지가 아니다) — 프록시
  // route.ts만 신설(app/api/gates/[id]/backlinks, app/api/pull-requests/[id]/backlinks).
  gate: 'gates',
  pull_request: 'pull-requests',
} as const satisfies Record<string, string>;

export type BacklinksEntityType = keyof typeof ENTITY_ROUTE_SEGMENT;

interface EntityBacklinksSectionProps {
  entityType: BacklinksEntityType;
  entityId: string;
}

/**
 * story #2299(E-CONNECT) — 「이것을 가리키는 것들」 목록. 첫 자리는 story-detail-panel,
 * 두 번째 자리(doc `[slug]/view`)가 오면서 entityType/entityId 축으로 일반화했다(PO 지시:
 * "두 번째 자리가 올 때 일반화한다" — 소비자 없는 추상을 미리 짓지 않는다). API 경로는
 * ENTITY_ROUTE_SEGMENT로만 파생 — 화면 코드에 종류를 나열/분기하지 않는다.
 *
 * still_exists 표시 규율(유나 확定, entityType 무관):
 *  ①끊어진 항목도 목록에서 안 뺀다(그대로 보여줌 — 사라진 척 안 함).
 *  ②사실로 보인다 — 오류색/경고 아이콘 없이 회색(노랑=기다릴 것 전용, 여기는 아무도 안 기다림).
 *  ③문구는 비난 없이 「대상이 없습니다」(삭제됨/깨짐 같은 말 안 씀).
 *  ④backlink source 종류(doc/chat_message)와 무관하게 문구 한 벌.
 */
interface LoadedResult {
  entityType: BacklinksEntityType;
  entityId: string;
  items: BacklinkItem[];
  scope: CollectionScope | null;
}

export function EntityBacklinksSection({ entityType, entityId }: EntityBacklinksSectionProps) {
  const t = useTranslations('board');
  // story #4091(§c) — recipe-stage-label.ts/stage-role.ts/gate-approver-label.ts SSOT가
  // 전부 organization 네임스페이스에 산다(recipe-detail-view.tsx 등 기존 소비처와 동일).
  const tOrg = useTranslations('organization');
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  // story-detail-panel처럼 entityId만 바뀌고 이 컴포넌트가 리마운트 안 되는 호출부가 있을 수
  // 있다 — 결과에 entityType+entityId를 같이 담아 렌더 시점에 일치 여부로 판정한다(전환-누출
  // 방지, #2299 원본 회귀테스트와 동형. 동기 setState-in-effect도 그래서 안 씀).
  const [result, setResult] = useState<LoadedResult | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const segment = ENTITY_ROUTE_SEGMENT[entityType];
    fetchWithAuth(`/api/${segment}/${entityId}/backlinks`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: BacklinkItem[]; meta?: BacklinksMeta }>) : null))
      .then((json) => {
        if (cancelled) return;
        if (!json) { setResult('failed'); return; }
        setResult({ entityType, entityId, items: json.data ?? [], scope: json.meta?.collection_scope ?? null });
      })
      .catch(() => { if (!cancelled) setResult('failed'); });
    return () => { cancelled = true; };
  }, [entityType, entityId]);

  // 조용한 폴백 — 다른 애드온 섹션(stuck-handoff-section 등)과 동형, 로딩/실패/전환-중으로 노이즈를 안 낸다.
  if (result === null || result === 'failed' || result.entityType !== entityType || result.entityId !== entityId) return null;
  const { items, scope } = result;
  // story #2267(C-9) AC4 — relation==='created_from'인 항목은 「출처」(story-origin-section.tsx
  // 전용)이지 「이것을 가리키는 것들」(멘션)이 아니다. 같은 응답을 두 섹션이 각자 걸러 쓴다.
  const mentionItems = items.filter((item) => item.relation !== 'created_from');

  return (
    <div className="border-t border-border/60 px-4 py-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('backlinksTitle')}</p>
      {mentionItems.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {scope
            ? (() => {
                // story #4096 — excludes 목록(마지막 항목 기준)에 맞는 「은/는」을 렌더
                // 시점에 결정적으로 고른다(korean-particle.ts, more/page.tsx::moreTabHint와
                // 동일 패턴) — 조사를 메시지 문자열에 고정하지 않는다.
                const excludesText = scope.excludes
                  .map((k) => (EXCLUDE_LABEL_KEYS[k] ? t(EXCLUDE_LABEL_KEYS[k]!) : k))
                  .join('·');
                return t('backlinksEmptyScoped', {
                  // 매핑에 없는 코드(향후 BE가 source_types를 늘릴 경우)는 원문 코드
                  // 그대로 — 번역 키 오조회 대신 "정상 경로"로 보여준다(#2263 ㉢와 같은
                  // 원칙, excludes와 동형).
                  sources: scope.source_types
                    .map((k) => (SOURCE_TYPE_LABEL_KEYS[k] ? t(SOURCE_TYPE_LABEL_KEYS[k]!) : k))
                    .join('·'),
                  excludes: excludesText,
                  particle: pickEunNeunJosa(excludesText),
                });
              })()
            : t('backlinksEmptyFallback')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {mentionItems.map((item) => {
            const Icon = SOURCE_TYPE_ICON[item.source_type];
            const label = backlinkLabel(item, tOrg);
            const creatorName = item.created_by?.name;
            return (
              <li
                key={item.id}
                className={`flex items-start gap-2 text-xs ${item.still_exists ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <span className="[overflow-wrap:anywhere]">{label ?? item.source_id}</span>
                  {!item.still_exists && (
                    <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      {t('backlinksTargetGone')}
                    </span>
                  )}
                  <div className="text-[10px] text-muted-foreground">
                    {creatorName ? `${creatorName} · ` : ''}
                    {formatRelativeTime(item.created_at, locale, displayTimezone)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
