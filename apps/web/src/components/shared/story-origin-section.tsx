'use client';

import { useEffect, useState } from 'react';
import { FileText, MessageSquare, Calendar, BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';
import { getEntityHref } from '@/components/chat/embed-card';
import type { BacklinkItem } from './entity-backlinks-section';
import { deriveStoryOrigin } from './derive-story-origin';

// story #2267(C-9) AC4 — 이 컴포넌트는 EntityBacklinksSection과 같은 엔드포인트
// (GET /api/stories/{id}/backlinks)를 별도로 부른다. 두 섹션이 응답을 나눠 쓰도록
// EntityBacklinksSection의 내부-fetch 구조를 리팩터해 상태를 끌어올릴 수도 있었으나,
// 그 컴포넌트는 이미 테스트·다른 소비처(doc [slug]/view)가 있는 공유 컴포넌트라 공개
// 계약(props)을 넓히는 대신 — 상세 패널당 1회뿐인 가벼운 GET 중복을 택했다(스토리 상세는
// 자주 리렌더되는 목록이 아니다). 재사용 폭 넓히기가 필요해지면 그때 끌어올린다.
function sourceIcon(sourceType: BacklinkItem['source_type']) {
  switch (sourceType) {
    case 'doc': return FileText;
    case 'chat_message': return MessageSquare;
    case 'meeting': return Calendar;
    case 'story': return BookOpen;
  }
}

function sourceLabel(item: BacklinkItem): string | undefined {
  switch (item.source_type) {
    case 'doc': return item.doc?.title;
    case 'chat_message': return item.message?.content_snippet;
    case 'meeting': return item.meeting?.title;
    case 'story': return item.story?.title;
  }
}

// getEntityHref는 doc/story만 안다(embed-card.tsx) — chat_message/meeting은 그 라우팅
// 관례가 아니라 이 파일에서 직접 구성한다(#2277 ade2d6d5 딥링크 관례: /chats/{id}?messageId=).
function sourceHref(item: BacklinkItem): string | null {
  switch (item.source_type) {
    case 'doc': return item.doc ? getEntityHref('doc', item.doc.id) : null;
    case 'story': return item.story ? getEntityHref('story', item.story.id) : null;
    case 'chat_message':
      return item.message ? `/chats/${encodeURIComponent(item.message.conversation_id)}?messageId=${encodeURIComponent(item.message.id)}` : null;
    case 'meeting': return item.meeting ? `/meetings/${encodeURIComponent(item.meeting.id)}` : null;
  }
}

interface StoryOriginSectionProps {
  storyId: string;
}

interface LoadedResult {
  storyId: string;
  items: BacklinkItem[];
}

/**
 * story #2267(C-9) AC4/AC7 — 「무엇에서 만들었나」(출처)를 「어느 그룹에 속하는가」
 * (컨테이너: epic/sprint/meeting_id)와 별도 섹션으로 그린다. relation==='created_from'인
 * backlink 항목이 곧 출처다. 못 찾으면(진짜 없음·미수집 구분 불가) 항상 같은 문구
 * (originNotCollected) — AC7 계약대로 분기하지 않는다.
 */
export function StoryOriginSection({ storyId }: StoryOriginSectionProps) {
  const t = useTranslations('board');
  const [result, setResult] = useState<LoadedResult | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stories/${storyId}/backlinks`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: BacklinkItem[] }>) : null))
      .then((json) => {
        if (cancelled) return;
        if (!json) { setResult('failed'); return; }
        setResult({ storyId, items: json.data ?? [] });
      })
      .catch(() => { if (!cancelled) setResult('failed'); });
    return () => { cancelled = true; };
  }, [storyId]);

  // 조용한 폴백 — EntityBacklinksSection과 동형(로딩/실패/전환-중 노이즈 없음).
  if (result === null || result === 'failed' || result.storyId !== storyId) return null;

  const origin = deriveStoryOrigin(result.items);

  return (
    <div className="border-t border-border/60 px-4 py-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('originTitle')}</p>
      {origin ? (
        (() => {
          const Icon = sourceIcon(origin.source_type);
          const label = sourceLabel(origin);
          const href = sourceHref(origin);
          const creatorName = origin.created_by?.name;
          const content = (
            <span className="flex items-start gap-2 text-xs">
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="[overflow-wrap:anywhere]">{label ?? origin.source_id}</span>
                {!origin.still_exists && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    {t('backlinksTargetGone')}
                  </span>
                )}
                <span className="block text-[10px] text-muted-foreground">
                  {creatorName ? `${creatorName} · ` : ''}
                  {formatRelativeTime(origin.created_at)}
                </span>
              </span>
            </span>
          );
          return href ? (
            <a href={href} className="block text-foreground hover:underline">{content}</a>
          ) : (
            <span className="block text-foreground">{content}</span>
          );
        })()
      ) : (
        <p className="text-xs text-muted-foreground">{t('originNotCollected')}</p>
      )}
    </div>
  );
}
