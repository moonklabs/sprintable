'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatListView } from '@/components/chat/chat-list-view';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * story #2921 S1(P0-C, 챗 리디자인 시안 §S1) — D04 「Chat 분리=맥락 두동강」 처방 골격.
 * 현행 `/chats`(L1 리스트)↔`/chats/[id]`(L2/L3)는 완전히 분리된 라우트라 대화 하나를 열면
 * 리스트가 화면에서 통째로 사라졌다(전체 페이지 전환, 회귀 0 근거는 story 그라운딩 참고).
 * 이 layout이 두 라우트를 감싸 **데스크톱(lg↑)은 영구 스플릿뷰**(리스트 270px 고정 좌 레일 +
 * 대화 우 outlet, 동시에 보임)로 봉합한다 — **모바일은 시안 §S1 명시대로 현행 그대로**
 * (좁은 폭에서는 라우트별로 한쪽만 전체화면, 기존 UX 무변경).
 *
 * `ChatListView`(리스트 본체)를 이 layout이 유일하게 마운트한다 — `/chats/page.tsx`는 더는
 * 리스트를 안 그린다(데스크톱 빈 상태만). 두 라우트가 각자 리스트를 따로 마운트하면 SSE
 * 구독·fetch가 이중으로 뜬다(이 세션 초반부터 반복된 "구독 중복" 사고 클래스) — 단일 마운트
 * 지점 하나로 그 위험 자체를 구조적으로 없앤다.
 */
export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('chats');
  const pathname = usePathname();
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const [showModal, setShowModal] = useState(false);

  // `/chats` 정확히 그 경로일 때만 "리스트가 곧 전체화면"인 모바일 상태 — `/chats/[id]`류는
  // 전부 대화 쪽이 전체화면이다(이미 열람 중인 대화 화면에 리스트를 노출하지 않는다, 기존
  // 라우트 전환 UX 그대로 계승).
  const isListRoute = pathname === '/chats';

  if (!currentTeamMemberId || !projectId) {
    return (
      <div className="flex h-64 items-center justify-center">
        <EmptyState title="로딩 중…" description="" className="w-full max-w-xs" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* 리스트 레일 — 모바일은 `/chats`일 때만 전체화면(현행 유지), 데스크톱(lg↑)은 항상
          270px 고정 폭으로 보인다(§S1 확定 수치). */}
      <div
        data-testid="chat-rail"
        className={`${isListRoute ? 'flex' : 'hidden'} lg:flex min-h-0 w-full flex-col overflow-hidden border-border lg:w-[270px] lg:shrink-0 lg:border-r`}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-2.5">
          <h1 className="text-sm font-medium text-foreground">{t('title')}</h1>
          <Button size="sm" variant="outline" onClick={() => setShowModal(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newConversation')}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatListView
            projectId={projectId}
            currentTeamMemberId={currentTeamMemberId}
            open={showModal}
            onOpenChange={setShowModal}
          />
        </div>
      </div>

      {/* 대화 outlet — 모바일은 리스트가 아닌 라우트(`/chats/[id]`)일 때만 전체화면, 데스크톱은
          항상 리스트 옆에 병렬로 보인다. */}
      <div data-testid="chat-outlet" className={`${isListRoute ? 'hidden' : 'flex'} lg:flex min-h-0 flex-1 flex-col overflow-hidden`}>
        {children}
      </div>
    </div>
  );
}
