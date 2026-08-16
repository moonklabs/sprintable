'use client';

import { useEffect, useState } from 'react';
import { FileText, MessageSquare, Calendar, BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';
import { getEntityHref } from '@/components/chat/embed-card';
import { parseCursorMeta } from '@/lib/pagination';
import type { BacklinkItem } from './entity-backlinks-section';
import { deriveStoryOrigin } from './derive-story-origin';

import { fetchWithAuth } from '@/lib/db/client';

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

interface BacklinksPage {
  data?: BacklinkItem[];
  meta?: unknown;
}

// story #2267(C-9) AC4/AC7 — PO 지적(2026-07-30): /backlinks는 커서 페이지네이션(기본
// limit=30, created_at DESC)이라 `data.some(...)`을 첫 페이지에만 걸면 거짓 「미수집」이
// 난다 — created_from은 스토리 생성 시 «단 한 번» 기록되는 유일 행이라 창조 시점이 곧
// created_at이고, 그 뒤에 쌓인 멘션이 30건만 넘어도 DESC 정렬에서 통째로 뒤 페이지로
// 밀려난다(있는데 «없다»고 하는 것). ⇒ limit=200(BE 상한)으로 크게 물고, 못 찾으면
// has_more를 따라 다음 페이지까지 이어 찾는다. MAX_PAGES=10(최대 2000건)은 방어적
// 상한일 뿐 — created_from은 유일 행이므로 실사용에서 이 상한에 걸릴 일은 없다.
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

async function findOriginAcrossPages(storyId: string, signal: { cancelled: boolean }): Promise<BacklinkItem[] | 'failed'> {
  let cursor: string | null = null;
  let collected: BacklinkItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) params.set('before', cursor);
    const res = await fetchWithAuth(`/api/stories/${storyId}/backlinks?${params}`, { cache: 'no-store' });
    if (signal.cancelled) return collected;
    if (!res.ok) return 'failed';
    const json = await res.json() as BacklinksPage;
    const items = json.data ?? [];
    collected = collected.concat(items);
    if (items.some((i) => i.relation === 'created_from')) return collected; // 찾았으면 더 안 넘긴다.
    // #2231 AC4 — 커서 페이지네이션 meta는 parseCursorMeta()로만 읽는다(직접 옵셔널 체이닝
    // 금지, 저장소 전수 가드 테스트가 새 자리를 잡는다).
    const pageMeta = parseCursorMeta(json.meta, 'story-origin-section');
    if (!pageMeta.hasMore || !pageMeta.nextCursor) return collected; // 다 봤다(진짜 없거나 미수집).
    cursor = pageMeta.nextCursor;
    if (page === MAX_PAGES - 1) {
      // PO 지적(2026-07-30) — "MAX_PAGES 상한에 걸려서 모름"과 "정말 없어서 모름"은 화면에서
      // 같은 문구(originNotCollected)로 정직하게 통일되지만("모름"이니 거짓은 아님), created_from은
      // 유일 행이라 2000건을 넘겨도 못 찾는 것은 «있을 수 없는 일» — 즉 결함 신호다. 화면은
      // 그대로 「모름」이되, 개발자에게만 알린다(오늘 "가드는 CI에·폴백은 운영에"의 세 번째 얼굴).
      console.warn(`[story-origin-section] MAX_PAGES(${MAX_PAGES}) 상한까지 다 봤는데 storyId=${storyId}의 created_from을 못 찾았다 — created_from은 유일 행이라 이 상한에 걸리는 것 자체가 비정상.`);
    }
  }
  return collected;
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
    const signal = { cancelled: false };
    findOriginAcrossPages(storyId, signal)
      .then((outcome) => {
        if (signal.cancelled) return;
        if (outcome === 'failed') { setResult('failed'); return; }
        setResult({ storyId, items: outcome });
      })
      .catch(() => { if (!signal.cancelled) setResult('failed'); });
    return () => { signal.cancelled = true; };
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
