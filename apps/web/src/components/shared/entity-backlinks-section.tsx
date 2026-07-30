'use client';

import { useEffect, useState } from 'react';
import { FileText, MessageSquare, Calendar, BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';

interface BacklinkMember { id: string; name: string; type: string }

// export: story #2267(C-9) — story-origin-section.tsx가 같은 응답 형상을 소비한다(출처는
// 이 목록과 같은 엔드포인트·같은 item 형상, relation 축으로만 갈린다).
export interface BacklinkItem {
  id: string;
  // story #2267(C-9): meeting·story도 source가 될 수 있다(backend/app/services/backlinks.py
  // 동반 확장) — doc·chat_message 둘뿐이던 것에서 넓어짐.
  source_type: 'chat_message' | 'doc' | 'meeting' | 'story';
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
  message: { id: string; conversation_id: string; content_snippet: string; sender: BacklinkMember | null } | null;
  meeting: { id: string; title: string } | null;
  story: { id: string; title: string } | null;
}

const SOURCE_TYPE_ICON = {
  doc: FileText,
  chat_message: MessageSquare,
  meeting: Calendar,
  story: BookOpen,
} as const satisfies Record<BacklinkItem['source_type'], unknown>;

function backlinkLabel(item: BacklinkItem): string | undefined {
  switch (item.source_type) {
    case 'doc': return item.doc?.title;
    case 'chat_message': return item.message?.content_snippet;
    case 'meeting': return item.meeting?.title;
    case 'story': return item.story?.title;
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

/** excludes 코드 → i18n 키. BE가 사실만 주고 문안은 FE 몫(collection_scope 주석 그대로). */
const EXCLUDE_LABEL_KEYS: Record<string, string> = {
  pr_sid_text_convention: 'backlinksExcludePrSid',
  evidence_free_text_reference: 'backlinksExcludeEvidenceFreeText',
};

/** BacklinksEntityType → BE 라우트 세그먼트. 불규칙복수(story→stories)라 순수 접미사 파생이
 * 아닌 조회 테이블로 연다 — PROJECT_ID_RESOLVERS와 같은 성격(종류-분기가 아니라 표기 파생).
 *
 * ⛔이 맵의 키 집합은 BE `backlinks.py::BACKLINKS_ALLOWED_TARGET_TYPES`(현재
 * `frozenset({"doc", "story"})`)와 **글자 그대로 같은 집합**이어야 한다 — 미리 늘리지 않는다.
 * epic 등 나머지 registry 타입이 거기 없는 이유는 "라우트가 없어서"가 아니라 그 라우터들에
 * `_require_doc_project_access`/`_assert_story_project_access`와 동형인 TARGET
 * project-access 선-게이트가 아직 없어서다(PO 확認, 2026-07-28) — 게이트 없이 여기 먼저
 * 추가하면 화면이 "게이트 없는 라우트"를 부르게 된다.
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
  // story-detail-panel처럼 entityId만 바뀌고 이 컴포넌트가 리마운트 안 되는 호출부가 있을 수
  // 있다 — 결과에 entityType+entityId를 같이 담아 렌더 시점에 일치 여부로 판정한다(전환-누출
  // 방지, #2299 원본 회귀테스트와 동형. 동기 setState-in-effect도 그래서 안 씀).
  const [result, setResult] = useState<LoadedResult | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const segment = ENTITY_ROUTE_SEGMENT[entityType];
    fetch(`/api/${segment}/${entityId}/backlinks`, { cache: 'no-store' })
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
            ? t('backlinksEmptyScoped', {
                sources: scope.source_types.join('·'),
                // 매핑에 없는 코드(향후 BE가 excludes를 늘릴 경우)는 원문 코드 그대로 — 번역
                // 키 오조회 대신 "정상 경로"로 보여준다(#2263 ㉢와 같은 원칙).
                excludes: scope.excludes.map((k) => (EXCLUDE_LABEL_KEYS[k] ? t(EXCLUDE_LABEL_KEYS[k]!) : k)).join('·'),
              })
            : t('backlinksEmptyFallback')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {mentionItems.map((item) => {
            const Icon = SOURCE_TYPE_ICON[item.source_type];
            const label = backlinkLabel(item);
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
                    {formatRelativeTime(item.created_at)}
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
