import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MemoEventDispatcher } from './memo-event-dispatcher';
import { buildAbsoluteMemoLink } from './app-url';

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

  const { isOssMode, createTeamMemberRepository } = await import('@/lib/storage/factory');

  if (isOssMode()) {
    try {
      const teamMemberRepo = await createTeamMemberRepository();
      const member = await teamMemberRepo.getById(memo.assigned_to).catch(() => null);
      if (!member?.webhook_url) return;

      const memoLabel = memo.title?.trim() ? `"${memo.title.trim()}"` : `#${memo.id.slice(0, 8)}`;
      const title = `📋 메모 배정: ${memoLabel}`;
      const preview = memo.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      const memoLink = buildAbsoluteMemoLink(memo.id, process.env.NEXT_PUBLIC_APP_URL);
      const description = `${preview}\n\n${memoLink}`;

      const isDiscord = member.webhook_url.includes('discord.com') || member.webhook_url.includes('discordapp.com');
      const body = isDiscord
        ? JSON.stringify({ content: `${title}\n${description.substring(0, 500)}`, embeds: [{ title, description, color: 0x3B82F6 }] })
        : JSON.stringify({ text: `*${title}*\n${description}` });

      await fetch(member.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.warn(
        '[MemoDispatch] OSS assignment dispatch failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }

  try {
    const dispatcher = new MemoEventDispatcher({
      supabase: createSupabaseAdminClient(),
      logger: console,
    });

    const result = await dispatcher.dispatchMemoIfNeeded(memo, 'realtime');
    await dispatcher.stop();

    if (result.status === 'skipped') {
      console.error(
        '[MemoDispatch] dispatch skipped:',
        result.reason ?? 'unknown_reason',
      );
    }
  } catch (error) {
    console.error(
      '[MemoDispatch] immediate assignment dispatch failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
