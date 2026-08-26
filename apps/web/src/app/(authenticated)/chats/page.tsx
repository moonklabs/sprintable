'use client';

import { useTranslations } from 'next-intl';
import { MessageSquare } from 'lucide-react';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * story #2921 S1 — 리스트 본체는 `chats/layout.tsx`(영구 좌측 레일)로 이관됐다. 이 페이지는
 * 이제 데스크톱 스플릿뷰의 **우측 outlet 빈 상태**만 그린다(모바일은 layout이 이 outlet
 * 자체를 숨겨 아예 안 보인다 — `/chats` 경로에서 모바일은 레일이 전체화면을 차지, 현행 유지).
 */
export default function ChatsPage() {
  const t = useTranslations('chats');

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<MessageSquare className="size-8 text-muted-foreground" />}
          title={t('title')}
          description="왼쪽에서 대화를 선택하세요"
          className="w-full max-w-xs"
        />
      </div>
    </>
  );
}
