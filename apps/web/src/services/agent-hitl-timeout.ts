import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchMemoAssignmentImmediately, type DispatchableMemo } from './memo-assignment-dispatch';
import { syncSlackHitlRequestState } from './slack-hitl';
import { NotificationService } from './notification.service';

const DEFAULT_REMINDER_WINDOW_MINUTES = 60;
const MAX_REMINDER_WINDOW_MINUTES = 24 * 60;
const DEFAULT_SCAN_LIMIT = 50;

interface HitlTimeoutRequestRow {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  run_id: string | null;
  requested_for: string;
  title: string;
  prompt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
  response_text: string | null;
  expires_at: string | null;
  reminder_sent_at?: string | null;
  expired_at?: string | null;
  metadata: Record<string, unknown> | null;
}

interface AgentRunStateRow {
  id: string;
  status: string;
  result_summary?: string | null;
  finished_at?: string | null;
  last_error_code?: string | null;
  error_message?: string | null;
}

type Compensation = () => Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asPositiveInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function getReminderMinutes(request: HitlTimeoutRequestRow) {
  return asPositiveInteger(asRecord(request.metadata)?.reminder_minutes_before, DEFAULT_REMINDER_WINDOW_MINUTES);
}

function getEscalationMode(request: HitlTimeoutRequestRow) {
  const value = asString(asRecord(request.metadata)?.escalation_mode);
  return value === 'timeout_memo_and_escalate' ? value : 'timeout_memo';
}

function getReminderLeadLabel(minutes: number) {
  if (minutes % 60 === 0) {
    return `${minutes / 60}시간`;
  }
  return `${minutes}분`;
}

function dedupe(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export class AgentHitlTimeoutService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly options: {
      now?: () => Date;
      syncSlackHitlFn?: typeof syncSlackHitlRequestState;
      logger?: Pick<Console, 'warn' | 'error'>;
    } = {},
  ) {}

  async scan(input?: { limit?: number }) {
    const limit = input?.limit ?? DEFAULT_SCAN_LIMIT;
    const now = this.now().toISOString();
    const reminderDeadline = new Date(this.now().getTime() + (MAX_REMINDER_WINDOW_MINUTES * 60 * 1000)).toISOString();

    const reminders = await this.processReminderWindow(now, reminderDeadline, limit);
    const timedOut = await this.processTimeouts(now, limit);

    return {
      reminders_sent: reminders.sent,
      reminder_request_ids: reminders.requestIds,
      timed_out: timedOut.count,
      timeout_request_ids: timedOut.requestIds,
      timeout_memo_ids: timedOut.memoIds,
      skipped_timeout_request_ids: timedOut.skippedRequestIds,
    };
  }

  private async processReminderWindow(now: string, reminderDeadline: string, limit: number) {
    const candidates = await this.listReminderCandidates(now, reminderDeadline);
    const candidateIds = candidates
      .filter((request) => {
        if (!request.expires_at) return false;
        const reminderLeadMs = getReminderMinutes(request) * 60 * 1000;
        return new Date(request.expires_at).getTime() - new Date(now).getTime() <= reminderLeadMs;
      })
      .map((request) => request.id)
      .slice(0, limit);
    if (candidateIds.length === 0) {
      return { sent: 0, requestIds: [] as string[] };
    }

    const claimed = await this.claimReminderCandidates(candidateIds, now);
    if (claimed.length === 0) {
      return { sent: 0, requestIds: [] as string[] };
    }

    const notifications = claimed.map((request) => {
      const reminderMinutes = getReminderMinutes(request);
      const reminderLeadLabel = getReminderLeadLabel(reminderMinutes);
      return {
        org_id: request.org_id,
        user_id: request.requested_for,
        type: 'warning' as const,
        title: 'HITL 요청 만료 임박',
        body: `${request.title} 요청의 응답 기한이 ${reminderLeadLabel} 이내로 남았습니다.`,
        reference_type: 'memo',
        reference_id: asString(asRecord(request.metadata)?.hitl_memo_id) ?? asString(asRecord(request.metadata)?.source_memo_id),
      };
    });

    try {
      await new NotificationService(this.supabase).createMany(notifications);
    } catch (notifError) {
      await this.supabase
        .from('agent_hitl_requests')
        .update({ reminder_sent_at: null })
        .in('id', claimed.map((request) => request.id));
      throw notifError;
    }

    return {
      sent: claimed.length,
      requestIds: claimed.map((request) => request.id),
    };
  }

  private async processTimeouts(now: string, limit: number) {
    const candidateIds = await this.listExpiredCandidateIds(now, limit);
    if (candidateIds.length === 0) {
      return { count: 0, requestIds: [] as string[], memoIds: [] as string[], skippedRequestIds: [] as string[] };
    }

    const claimed = await this.claimExpiredCandidates(candidateIds, now);
    if (claimed.length === 0) {
      return { count: 0, requestIds: [] as string[], memoIds: [] as string[], skippedRequestIds: [] as string[] };
    }

    const runsById = await this.loadRunStates(dedupe(claimed.map((request) => request.run_id)));
    const processable = claimed.filter((request) => request.run_id && runsById.get(request.run_id)?.status === 'hitl_pending');
    const skippedBeforeRunUpdate = claimed.filter((request) => !processable.some((row) => row.id === request.id));
    await this.clearExpiredClaims(skippedBeforeRunUpdate.map((request) => request.id));

    if (processable.length === 0) {
      return {
        count: 0,
        requestIds: [] as string[],
        memoIds: [] as string[],
        skippedRequestIds: skippedBeforeRunUpdate.map((request) => request.id),
      };
    }

    const runIds = dedupe(processable.map((request) => request.run_id));
    const { data: transitionedRuns, error: runError } = await this.supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        result_summary: 'HITL timed out before approval',
        finished_at: now,
        last_error_code: 'hitl_timeout',
        error_message: 'No admin response before the HITL deadline',
      })
      .in('id', runIds)
      .eq('status', 'hitl_pending')
      .select('id');

    if (runError) throw runError;

    const transitionedRunIds = new Set((transitionedRuns ?? []).map((row) => String((row as { id: string }).id)));
    const transitionedRequests = processable.filter((request) => request.run_id && transitionedRunIds.has(request.run_id));
    const skippedAfterRunUpdate = processable.filter((request) => !transitionedRequests.some((row) => row.id === request.id));
    await this.clearExpiredClaims(skippedAfterRunUpdate.map((request) => request.id));

    if (transitionedRequests.length === 0) {
      return {
        count: 0,
        requestIds: [] as string[],
        memoIds: [] as string[],
        skippedRequestIds: [
          ...skippedBeforeRunUpdate.map((request) => request.id),
          ...skippedAfterRunUpdate.map((request) => request.id),
        ],
      };
    }

    const rollbackRunStates = transitionedRequests
      .map((request) => (request.run_id ? runsById.get(request.run_id) ?? null : null))
      .filter((row): row is AgentRunStateRow => Boolean(row))
      .map((row) => ({ ...row }));

    const compensations: Compensation[] = [
      async () => {
        for (const run of rollbackRunStates) {
          await this.supabase
            .from('agent_runs')
            .update({
              status: run.status,
              result_summary: run.result_summary ?? null,
              finished_at: run.finished_at ?? null,
              last_error_code: run.last_error_code ?? null,
              error_message: run.error_message ?? null,
            })
            .eq('id', run.id);
        }
      },
      async () => {
        await this.clearExpiredClaims(transitionedRequests.map((request) => request.id));
      },
    ];

    const timeoutMemoIdByRequestId = new Map<string, string>();

    try {
      const timeoutMemoRows = await Promise.all(transitionedRequests.map(async (request) => {
        const metadata = asRecord(request.metadata);
        const sourceMemoTitle = asString(metadata?.source_memo_title) ?? request.title;
        const escalationMode = getEscalationMode(request);
        const timeoutAssignee = escalationMode === 'timeout_memo_and_escalate'
          ? await this.resolveEscalationRecipient(request)
          : request.requested_for;
        return {
          org_id: request.org_id,
          project_id: request.project_id,
          title: `${escalationMode === 'timeout_memo_and_escalate' ? 'HITL timeout escalation' : 'HITL timeout'} · ${sourceMemoTitle}`,
          content: [
            'HITL 요청이 응답 없이 만료되어 실행을 종료했습니다.',
            `원본 메모: ${sourceMemoTitle}`,
            `원본 메모 ID: ${asString(metadata?.source_memo_id) ?? '-'}`,
            `HITL 메모 ID: ${asString(metadata?.hitl_memo_id) ?? '-'}`,
            `HITL 요청 ID: ${request.id}`,
            `만료 시각: ${request.expires_at ?? now}`,
            `만료 후 처리: ${escalationMode}`,
            escalationMode === 'timeout_memo_and_escalate' ? `에스컬레이션 담당자: ${timeoutAssignee}` : null,
          ].filter(Boolean).join('\n\n'),
          memo_type: 'task',
          assigned_to: timeoutAssignee,
          created_by: request.agent_id,
          metadata: {
            kind: 'hitl_timeout',
            hitl_request_id: request.id,
            source_memo_id: asString(metadata?.source_memo_id),
            hitl_memo_id: asString(metadata?.hitl_memo_id),
            run_id: request.run_id,
            expired_at: request.expires_at ?? now,
            escalation_mode: escalationMode,
            escalated_to: timeoutAssignee,
          },
        };
      }));

      const { data: timeoutMemos, error: timeoutMemoError } = await this.supabase
        .from('memos')
        .insert(timeoutMemoRows)
        .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, metadata, updated_at, created_at');
      if (timeoutMemoError) throw timeoutMemoError;

      const timeoutMemoIds = (timeoutMemos ?? []).map((memo) => String((memo as { id: string }).id));
      compensations.unshift(async () => {
        if (timeoutMemoIds.length === 0) return;
        await this.supabase.from('memos').delete().in('id', timeoutMemoIds);
      });

      for (const memo of timeoutMemos ?? []) {
        const metadata = asRecord((memo as { metadata?: unknown }).metadata);
        const requestId = asString(metadata?.hitl_request_id);
        if (requestId) timeoutMemoIdByRequestId.set(requestId, String((memo as { id: string }).id));
      }

      await Promise.all((timeoutMemos ?? []).map((memo) => dispatchMemoAssignmentImmediately(memo as DispatchableMemo)));

      const sourceReplies = transitionedRequests.flatMap((request) => {
        const metadata = asRecord(request.metadata);
        const sourceMemoId = asString(metadata?.source_memo_id);
        if (!sourceMemoId) return [];
        const escalationMode = getEscalationMode(request);
        return [{
          memo_id: sourceMemoId,
          created_by: request.agent_id,
          content: [
            'HITL 응답 기한이 지나 실행을 종료했습니다.',
            '',
            `Timeout memo: ${timeoutMemoIdByRequestId.get(request.id) ?? '-'}`,
            escalationMode === 'timeout_memo_and_escalate' ? '후속 조치를 위해 timeout memo를 에스컬레이션한.' : null,
          ].filter(Boolean).join('\n'),
          review_type: 'comment',
        }];
      });

      const hitlReplies = transitionedRequests.flatMap((request) => {
        const metadata = asRecord(request.metadata);
        const hitlMemoId = asString(metadata?.hitl_memo_id);
        if (!hitlMemoId) return [];
        return [{
          memo_id: hitlMemoId,
          created_by: request.agent_id,
          content: [
            '[HITL timeout]',
            '',
            '응답 기한 초과로 요청이 자동 종료된.',
            `Timeout memo: ${timeoutMemoIdByRequestId.get(request.id) ?? '-'}`,
          ].join('\n'),
          review_type: 'comment',
        }];
      });

      const replyRows = [...sourceReplies, ...hitlReplies];
      if (replyRows.length > 0) {
        const { data: insertedReplies, error: replyError } = await this.supabase
          .from('memo_replies')
          .insert(replyRows)
          .select('id');
        if (replyError) throw replyError;

        const replyIds = (insertedReplies ?? []).map((reply) => String((reply as { id: string }).id));
        compensations.unshift(async () => {
          if (replyIds.length === 0) return;
          await this.supabase.from('memo_replies').delete().in('id', replyIds);
        });
      }

      const hitlMemoIds = dedupe(transitionedRequests.map((request) => asString(asRecord(request.metadata)?.hitl_memo_id)));
      if (hitlMemoIds.length > 0) {
        const { error: resolveHitlMemoError } = await this.supabase
          .from('memos')
          .update({ status: 'resolved', resolved_at: now, resolved_by: null })
          .in('id', hitlMemoIds)
          .eq('status', 'open');
        if (resolveHitlMemoError) throw resolveHitlMemoError;

        compensations.unshift(async () => {
          await this.supabase
            .from('memos')
            .update({ status: 'open', resolved_at: null, resolved_by: null })
            .in('id', hitlMemoIds);
        });
      }

      const { data: expiredRequests, error: requestUpdateError } = await this.supabase
        .from('agent_hitl_requests')
        .update({
          status: 'expired',
          response_text: 'HITL timeout',
          responded_at: now,
        })
        .in('id', transitionedRequests.map((request) => request.id))
        .eq('status', 'pending')
        .select('id');
      if (requestUpdateError) throw requestUpdateError;

      const expiredRequestIds = new Set((expiredRequests ?? []).map((request) => String((request as { id: string }).id)));
      if (expiredRequestIds.size !== transitionedRequests.length) {
        throw new Error('hitl_timeout_request_transition_mismatch');
      }
    } catch (error) {
      await this.rollback(compensations);
      throw error;
    }

    await Promise.allSettled(transitionedRequests.map(async (request) => {
      try {
        await (this.options.syncSlackHitlFn ?? syncSlackHitlRequestState)(this.supabase, {
          request: {
            ...request,
            status: 'expired',
            response_text: 'HITL timeout',
          },
          hitlMemoId: asString(asRecord(request.metadata)?.hitl_memo_id),
          sourceMemoId: asString(asRecord(request.metadata)?.source_memo_id),
          actorId: request.agent_id,
        }, {
          appUrl: process.env.NEXT_PUBLIC_APP_URL,
          logger: this.options.logger,
        });
      } catch (error) {
        this.options.logger?.warn?.(`[AgentHitlTimeoutService] slack timeout sync failed: ${error instanceof Error ? error.message : 'unknown_error'}`);
      }
    }));

    return {
      count: transitionedRequests.length,
      requestIds: transitionedRequests.map((request) => request.id),
      memoIds: [...timeoutMemoIdByRequestId.values()],
      skippedRequestIds: [
        ...skippedBeforeRunUpdate.map((request) => request.id),
        ...skippedAfterRunUpdate.map((request) => request.id),
      ],
    };
  }

  private async listReminderCandidates(now: string, reminderDeadline: string) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .select('id, org_id, project_id, agent_id, run_id, requested_for, title, prompt, status, response_text, expires_at, reminder_sent_at, expired_at, metadata')
      .eq('status', 'pending')
      .is('reminder_sent_at', null)
      .not('expires_at', 'is', null)
      .gt('expires_at', now)
      .lte('expires_at', reminderDeadline)
      .order('expires_at');

    if (error) throw error;
    return (data ?? []) as HitlTimeoutRequestRow[];
  }

  private async claimReminderCandidates(ids: string[], now: string) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .update({ reminder_sent_at: now })
      .in('id', ids)
      .eq('status', 'pending')
      .is('reminder_sent_at', null)
      .select('id, org_id, project_id, agent_id, run_id, requested_for, title, prompt, status, response_text, expires_at, reminder_sent_at, expired_at, metadata');

    if (error) throw error;
    return (data ?? []) as HitlTimeoutRequestRow[];
  }

  private async listExpiredCandidateIds(now: string, limit: number) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .select('id')
      .eq('status', 'pending')
      .is('expired_at', null)
      .not('expires_at', 'is', null)
      .lte('expires_at', now)
      .order('expires_at')
      .limit(limit);

    if (error) throw error;
    return (data ?? []).map((row) => String((row as { id: string }).id));
  }

  private async claimExpiredCandidates(ids: string[], now: string) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .update({ expired_at: now })
      .in('id', ids)
      .eq('status', 'pending')
      .is('expired_at', null)
      .select('id, org_id, project_id, agent_id, run_id, requested_for, title, prompt, status, response_text, expires_at, reminder_sent_at, expired_at, metadata');

    if (error) throw error;
    return (data ?? []) as HitlTimeoutRequestRow[];
  }

  private async loadRunStates(runIds: string[]) {
    if (runIds.length === 0) return new Map<string, AgentRunStateRow>();

    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, status, result_summary, finished_at, last_error_code, error_message')
      .in('id', runIds);

    if (error) throw error;
    return new Map((data ?? []).map((row) => {
      const run = row as AgentRunStateRow;
      return [String(run.id), { ...run }];
    }));
  }

  private async clearExpiredClaims(requestIds: string[]) {
    if (requestIds.length === 0) return;

    const { error } = await this.supabase
      .from('agent_hitl_requests')
      .update({ expired_at: null })
      .in('id', requestIds)
      .eq('status', 'pending');

    if (error) throw error;
  }

  private async resolveEscalationRecipient(request: HitlTimeoutRequestRow) {
    const adminRecipients = await this.listActiveAdminRecipients(request.org_id, request.project_id);
    const alternateAdmin = adminRecipients.find((member) => member.id !== request.requested_for);
    return alternateAdmin?.id ?? request.requested_for;
  }

  private async listActiveAdminRecipients(orgId: string, projectId: string) {
    const { data: orgMembers, error: orgMembersError } = await this.supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .in('role', ['owner', 'admin']);

    if (orgMembersError) throw orgMembersError;

    const adminUserIds = (orgMembers ?? [])
      .map((row) => asString((row as { user_id?: unknown }).user_id))
      .filter((userId): userId is string => Boolean(userId));

    if (adminUserIds.length === 0) {
      return [] as Array<{ id: string }>;
    }

    const { data: teamMembers, error: teamMembersError } = await this.supabase
      .from('team_members')
      .select('id, user_id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('type', 'human')
      .eq('is_active', true)
      .in('user_id', adminUserIds);

    if (teamMembersError) throw teamMembersError;
    return (teamMembers ?? []) as Array<{ id: string; user_id?: string | null }>;
  }

  private async rollback(compensations: Compensation[]) {
    const failures: string[] = [];
    for (const compensate of compensations) {
      try {
        await compensate();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'rollback_failed');
      }
    }

    if (failures.length > 0) {
      this.options.logger?.error?.(`[AgentHitlTimeoutService] rollback failed: ${failures.join(', ')}`);
    }
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }
}
