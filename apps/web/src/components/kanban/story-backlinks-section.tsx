'use client';

import { useEffect, useState } from 'react';
import { FileText, MessageSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';

interface BacklinkMember { id: string; name: string; type: string }

interface BacklinkItem {
  id: string;
  source_type: 'chat_message' | 'doc';
  source_id: string;
  created_by: BacklinkMember | null;
  created_at: string;
  /** story #2299: 「끊어짐」은 사실 필드 — 색/문구는 여기(FE)서 정한다(BE는 계산만). */
  still_exists: boolean;
  doc: { id: string; title: string } | null;
  message: { id: string; conversation_id: string; content_snippet: string; sender: BacklinkMember | null } | null;
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

interface StoryBacklinksSectionProps {
  storyId: string;
}

/**
 * story #2299(E-CONNECT) — 「이것을 가리키는 것들」 목록. story-detail-panel 신설 섹션(첫 자리 —
 * doc [slug]/view는 후속 판, PO 지시대로 한 자리로 절차를 세운다).
 *
 * still_exists 표시 규율(유나 확定):
 *  ①끊어진 항목도 목록에서 안 뺀다(그대로 보여줌 — 사라진 척 안 함).
 *  ②사실로 보인다 — 오류색/경고 아이콘 없이 회색(노랑=기다릴 것 전용, 여기는 아무도 안 기다림).
 *  ③문구는 비난 없이 「대상이 없습니다」(삭제됨/깨짐 같은 말 안 씀).
 *  ④종류(doc/chat_message)와 무관하게 문구 한 벌.
 */
interface LoadedResult {
  storyId: string;
  items: BacklinkItem[];
  scope: CollectionScope | null;
}

export function StoryBacklinksSection({ storyId }: StoryBacklinksSectionProps) {
  const t = useTranslations('board');
  // story-detail-panel은 story 전환 시 이 컴포넌트를 리마운트하지 않는다(같은 인스턴스에
  // storyId prop만 바뀜) — 그래서 결과에 storyId를 같이 담아 「지금 보이는 결과가 지금
  // storyId 것인지」를 렌더 시점에 판정한다(effect 안에서 동기 setState로 리셋하는 대신 —
  // react-hooks/set-state-in-effect가 막는 패턴. 전환 중엔 이전 story 결과가 안 보인다).
  const [result, setResult] = useState<LoadedResult | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stories/${storyId}/backlinks`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: BacklinkItem[]; meta?: BacklinksMeta }>) : null))
      .then((json) => {
        if (cancelled) return;
        if (!json) { setResult('failed'); return; }
        setResult({ storyId, items: json.data ?? [], scope: json.meta?.collection_scope ?? null });
      })
      .catch(() => { if (!cancelled) setResult('failed'); });
    return () => { cancelled = true; };
  }, [storyId]);

  // 조용한 폴백 — 다른 애드온 섹션(stuck-handoff-section 등)과 동형, 로딩/실패/전환-중으로 노이즈를 안 낸다.
  if (result === null || result === 'failed' || result.storyId !== storyId) return null;
  const { items, scope } = result;

  return (
    <div className="border-t border-border/60 px-4 py-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('backlinksTitle')}</p>
      {items.length === 0 ? (
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
          {items.map((item) => {
            const Icon = item.source_type === 'doc' ? FileText : MessageSquare;
            const label = item.source_type === 'doc' ? item.doc?.title : item.message?.content_snippet;
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
