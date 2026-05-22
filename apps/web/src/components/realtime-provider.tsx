'use client';

import { ToastContainer, useToast } from '@/components/ui/toast';

interface RealtimeProviderProps {
  currentTeamMemberId?: string;
  children: React.ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const { toasts, dismissToast } = useToast();

  return (
    <>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
