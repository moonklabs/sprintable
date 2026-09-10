'use client';

import { useTranslations } from 'next-intl';
import { MessageSquare } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { EmptyState } from '@/components/ui/empty-state';
import { useChatRail } from './chat-rail-context';

/**
 * story #2921 S1 — 리스트 본체는 `chats/layout.tsx`(영구 좌측 레일)로 이관됐다. 이 페이지는
 * 이제 데스크톱 스플릿뷰의 **우측 outlet 빈 상태**만 그린다(모바일은 layout이 이 outlet
 * 자체를 숨겨 아예 안 보인다 — `/chats` 경로에서 모바일은 레일이 전체화면을 차지, 현행 유지).
 *
 * story #3788(B-③, 유나 定 2026-09-10 카드 착지) — 이 자리가 두 계약을 동시에 어겼었다:
 * ①제목에 구역 이름("채팅")을 써 "무엇이 없는지"를 못 말했다(구역 이름은 위 TopBarSlot에
 * 이미 있다) ②대화 0건이어도 항상 "왼쪽에서 대화를 선택하세요"를 그려 왼쪽 레일의
 * "대화가 없습니다"와 **동시에 두 세계**를 말했다(고를 게 없는데 고르라는 모순, 3784와
 * 같은 클래스). 처방 = `ChatRailContext`가 끌어올린 `conversationsLoading`/`conversationCount`
 * 로 세 갈래를 가른다 — 로딩 中엔 아무것도 안 그림(3784와 같은 형) · 0건이면 왼쪽과 **같은
 * 낱말**(`noConversations`, 설명 없음 — CTA는 레일 상단 "새 대화"가 이미 있다) · 있는데
 * 미선택이면 그때만 신설 `selectConversationPrompt`("왼쪽에서" 같은 방향어는 모바일에서
 * 레일이 전체화면이 되면 거짓이라 안 쓴다).
 */
export default function ChatsPage() {
  const t = useTranslations('chats');
  const { conversationsLoading, conversationCount } = useChatRail();

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
      <div className="flex h-full items-center justify-center">
        {!conversationsLoading && (
          conversationCount === 0 ? (
            <EmptyState
              icon={<MessageSquare className="size-8 text-muted-foreground" />}
              title={t('noConversations')}
              className="w-full max-w-xs"
            />
          ) : (
            <EmptyState
              icon={<MessageSquare className="size-8 text-muted-foreground" />}
              title={t('selectConversationPrompt')}
              className="w-full max-w-xs"
            />
          )
        )}
      </div>
    </>
  );
}
