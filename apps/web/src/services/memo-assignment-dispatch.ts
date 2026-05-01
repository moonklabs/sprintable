import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { buildAbsoluteMemoLink } from './app-url';
import { buildWebhookSignatureHeaders } from '@/lib/webhook-signature';
import { WebhookDeliveryService } from './webhook-delivery.service';

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
        ? JSON.stringify({ content: `${title}\n${description.substring(0, 500)}` })
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

  // SaaS: webhook_configs → team_members.webhook_url 직접 전송 (agent_runs 불필요)
  try {
    const supabase = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());
    const assigneeId = memo.assigned_to;

    // webhook_configs: project_id 기준 우선
    const { data: projectConfig } = await supabase
      .from('webhook_configs')
      .select('id, url, secret, channel')
      .eq('org_id', memo.org_id)
      .eq('member_id', assigneeId)
      .eq('project_id', memo.project_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    let webhookUrl: string | null = null;
    let webhookSecret: string | null = null;
    let webhookConfigId: string | null = null;
    let webhookChannel: string | null = null;

    if (projectConfig?.url) {
      webhookUrl = projectConfig.url as string;
      webhookSecret = (projectConfig.secret as string | null) ?? null;
      webhookConfigId = projectConfig.id as string;
      webhookChannel = (projectConfig.channel as string | null) ?? null;
    } else {
      // webhook_configs: org 기본값
      const { data: defaultConfig } = await supabase
        .from('webhook_configs')
        .select('id, url, secret, channel')
        .eq('org_id', memo.org_id)
        .eq('member_id', assigneeId)
        .is('project_id', null)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

      if (defaultConfig?.url) {
        webhookUrl = defaultConfig.url as string;
        webhookSecret = (defaultConfig.secret as string | null) ?? null;
        webhookConfigId = defaultConfig.id as string;
        webhookChannel = (defaultConfig.channel as string | null) ?? null;
      } else {
        // fallback: team_members.webhook_url (config_id 없음)
        const { data: member } = await supabase
          .from('team_members')
          .select('webhook_url')
          .eq('id', assigneeId)
          .eq('org_id', memo.org_id)
          .eq('project_id', memo.project_id)
          .eq('is_active', true)
          .maybeSingle();

        webhookUrl = (member?.webhook_url as string | null) ?? null;
      }
    }

    if (!webhookUrl) {
      console.error('[MemoDispatch] no webhook url for assignee:', assigneeId);
      return;
    }

    const memoLabel = memo.title?.trim() ? `"${memo.title.trim()}"` : `#${memo.id.slice(0, 8)}`;
    const title = `📋 메모 배정: ${memoLabel}`;
    const preview = memo.content.replace(/\s+/g, ' ').trim().slice(0, 200);
    const memoLink = buildAbsoluteMemoLink(memo.id, process.env.NEXT_PUBLIC_APP_URL);
    const description = `${preview}\n\n${memoLink}`;

    const isDiscord = webhookChannel === 'discord' || (!webhookChannel && (webhookUrl.includes('discord.com') || webhookUrl.includes('discordapp.com')));
    const body = isDiscord
      ? JSON.stringify({ content: `${title}\n${description.substring(0, 500)}` })
      : JSON.stringify({ text: `*${title}*\n${description}` });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildWebhookSignatureHeaders(webhookSecret, body),
    };

    const ok = await new WebhookDeliveryService(supabase).dispatch({
      org_id: memo.org_id,
      webhook_config_id: webhookConfigId,
      event_type: 'memo.assigned',
      url: webhookUrl,
      headers,
      body,
    });

    if (!ok) {
      console.error('[MemoDispatch] webhook delivery failed for assignee:', assigneeId);
    }
  } catch (error) {
    console.error(
      '[MemoDispatch] immediate assignment dispatch failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}
