'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useRealtimeMemos } from '@/hooks/use-realtime-memos';
import { ToastContainer, useToast } from '@/components/ui/toast';

interface RealtimeProviderProps {
  currentTeamMemberId?: string;
  children: React.ReactNode;
}

export function RealtimeProvider({ currentTeamMemberId, children }: RealtimeProviderProps) {
  const t = useTranslations('memos');
  const { toasts, addToast, dismissToast } = useToast();

  const handleNewMemo = useCallback(
    (memo: { title: string | null; content: string }, isAssignedToMe: boolean) => {
      addToast({
        title: isAssignedToMe ? `📌 ${t('assignedNotification')}` : `📝 ${t('newNotification')}`,
        body: memo.title || memo.content.slice(0, 60),
        type: isAssignedToMe ? 'warning' : 'info',
        isHighlight: isAssignedToMe,
      });
    },
    [addToast, t],
  );

  useRealtimeMemos({
    currentTeamMemberId,
    onNewMemo: handleNewMemo,
  });

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
