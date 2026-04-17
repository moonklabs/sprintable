import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoEventDispatcher } from './memo-event-dispatcher';

export interface DispatchableMemo {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  metadata?: Record<string, unknown> | null;
  updated_at: string;
  created_at: string;
}

export async function dispatchMemoAssignmentImmediately(memo: DispatchableMemo) {
  if (!memo.assigned_to || memo.status !== 'open') return;

  try {
    const dispatcher = new MemoEventDispatcher({
      supabase: createSupabaseAdminClient(),
      logger: console,
    });

    await dispatcher.dispatchMemoIfNeeded(memo, 'realtime');
    await dispatcher.stop();
  } catch (error) {
    console.warn(
      '[MemoDispatch] immediate assignment dispatch failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
