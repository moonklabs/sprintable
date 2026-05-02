
import type { SupabaseClient } from '@/types/supabase';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchWorkflowMemoReplyWebhooks } from './memo-reply-webhook-dispatch';

function createDbStub(options?: {
  priorReplies?: Array<Record<string, unknown>>;
  members?: Array<Record<string, unknown>>;
  webhookConfigs?: Array<Record<string, unknown>>;
  memoAssignees?: Array<Record<string, unknown>>;
}) {
  const priorReplies = options?.priorReplies ?? [
    { created_by: 'member-3', content: 'Earlier note from @Paulo Ortega' },
  ];
  const members = options?.members ?? [
    { id: 'member-1', name: 'Paulo Ortega', webhook_url: 'https://discord.com/api/webhooks/member-1/direct', is_active: true },
    { id: 'member-2', name: '까심 아르야', webhook_url: 'https://discord.com/api/webhooks/member-2/direct', is_active: true },
    { id: 'member-3', name: '디디 은와추쿠', webhook_url: null, is_active: true },
  ];
  const webhookConfigs = options?.webhookConfigs ?? [
    { id: 'config-1', org_id: 'org-1', member_id: 'member-1', project_id: 'project-1', is_active: true, url: 'https://discord.com/api/webhooks/member-1/project', secret: null, channel: 'discord' },
    { id: 'config-3', org_id: 'org-1', member_id: 'member-3', project_id: null, is_active: true, url: 'https://discord.com/api/webhooks/member-3/default', secret: null, channel: 'discord' },
  ];
  const memoAssignees = options?.memoAssignees ?? [];

  const db = {
    from(table: string) {
      if (table === 'team_members') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: members, error: null }).then(resolve);
          },
        };
      }

      if (table === 'memo_replies') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: priorReplies, error: null }).then(resolve);
          },
        };
      }

      if (table === 'memo_assignees') {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            return Promise.resolve({ data: memoAssignees, error: null }).then(resolve);
          },
        };
      }

      if (table === 'webhook_configs') {
        const filters = new Map<string, unknown>();
        return {
          select() { return this; },
          eq(column: string, value: unknown) {
            filters.set(column, value);
            return this;
          },
          is(column: string, value: unknown) {
            filters.set(column, value);
            return this;
          },
          limit() { return this; },
          maybeSingle: async () => {
            const data = webhookConfigs.find((config) => {
              return Array.from(filters.entries()).every(([column, value]) => (config as Record<string, unknown>)[column] === value);
            }) ?? null;
            return { data, error: null };
          },
        };
      }

      if (table === 'webhook_deliveries') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'delivery-1' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return db;
}

afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
});

describe('dispatchWorkflowMemoReplyWebhooks', () => {
  it('sends direct webhooks to workflow participants with project/default fallback', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const db = createDbStub();

    const result = await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Sprintable reply lane fix',
        created_by: 'member-1',
        assigned_to: 'member-2',
        metadata: { source: 'workflow-restart' },
      },
      reply: {
        id: 'reply-1',
        memo_id: 'memo-1',
        content: '재기록 완료. @디디 은와추쿠',
        created_by: 'member-2',
      },
    });

    expect(result).toEqual({ status: 'sent', sentCount: 2, failedRecipientCount: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/webhooks/member-1/project',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/webhooks/member-3/default',
      expect.objectContaining({ method: 'POST' }),
    );

    const firstPayload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(firstPayload.embeds?.[0]?.title).toBe('💬 답장: 까심 아르야');
    expect(String(firstPayload.embeds?.[0]?.description)).toContain('Sprintable reply lane fix');
    expect(String(firstPayload.embeds?.[0]?.description)).toContain('https://app.example.com/memos?id=memo-1');
  });

  it('falls back to APP_BASE_URL when appUrl is omitted', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com';
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const db = createDbStub();

    await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Sprintable reply lane fix',
        created_by: 'member-1',
        assigned_to: 'member-2',
        metadata: { source: 'workflow-restart' },
      },
      reply: {
        id: 'reply-1',
        memo_id: 'memo-1',
        content: '재기록 완료',
        created_by: 'member-2',
      },
    });

    const firstPayload = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(String(firstPayload.embeds?.[0]?.description)).toContain('https://app.example.com/memos?id=memo-1');
  });

  it('skips Discord source memos because bridge-based reply handling owns that path', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const db = createDbStub();

    const result = await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Inbound Discord memo',
        created_by: 'member-1',
        assigned_to: 'member-2',
        metadata: { source: 'discord', channel_id: 'channel-1' },
      },
      reply: {
        id: 'reply-1',
        memo_id: 'memo-1',
        content: '답장',
        created_by: 'member-2',
      },
    });

    expect(result).toEqual({ status: 'skipped', reason: 'discord_source_memo' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('dispatches to first-name mention with Korean honorific (e.g. @까심군)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const db = createDbStub();

    const result = await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'QA 요청',
        created_by: 'member-1',
        assigned_to: null,
        metadata: null,
      },
      reply: {
        id: 'reply-2',
        memo_id: 'memo-1',
        content: '@까심군 QA 검증 바라는.',
        created_by: 'member-3',
      },
    });

    expect(result.status).toBe('sent');
    const calledUrls = fetchFn.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain('https://discord.com/api/webhooks/member-1/project');
    expect(calledUrls).toContain('https://discord.com/api/webhooks/member-2/direct');
  });

  it('includes memo_assignees in participant set', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const db = createDbStub({
      memoAssignees: [{ member_id: 'member-2' }],
      priorReplies: [],
    });

    const result = await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'Assignee test',
        created_by: 'member-1',
        assigned_to: null,
        metadata: null,
      },
      reply: {
        id: 'reply-3',
        memo_id: 'memo-1',
        content: '작업 완료 보고.',
        created_by: 'member-3',
      },
    });

    expect(result.status).toBe('sent');
    const calledUrls = fetchFn.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain('https://discord.com/api/webhooks/member-1/project');
    expect(calledUrls).toContain('https://discord.com/api/webhooks/member-2/direct');
  });

  it('delivers to additionalRecipientIds not otherwise in participant set', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const db = createDbStub({ priorReplies: [], memoAssignees: [] });

    const result = await dispatchWorkflowMemoReplyWebhooks({
      db,
      fetchFn: fetchFn as typeof fetch,
      appUrl: 'https://app.example.com',
      memo: {
        id: 'memo-1',
        org_id: 'org-1',
        project_id: 'project-1',
        title: 'QA 킥오프',
        created_by: 'member-1',
        assigned_to: null,
        metadata: null,
      },
      reply: {
        id: 'reply-4',
        memo_id: 'memo-1',
        content: 'QA 시작 바라는.',
        created_by: 'member-1',
      },
      additionalRecipientIds: ['member-2'],
    });

    expect(result.status).toBe('sent');
    const calledUrls = fetchFn.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain('https://discord.com/api/webhooks/member-2/direct');
  });
});
