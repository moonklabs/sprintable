import { apiSuccess, apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { AgentRetryService } from '@/services/agent-retry';
import { fireWebhooks } from '@/services/webhook-notify';

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * GET /api/cron/retry-agent-runs
 *
 * AC1: 자동 재시도 실행 — next_retry_at 도래한 failed run을 재실행
 * AC3: 최종 실패만 admin 표시 — 3회 재시도 소진 시 알림 발송
 * AC4: 슬랙 알림 억제 — 재시도 중에는 알림 없음, 최종 실패 시에만 발송
 *
 * 외부 cron (GitHub Actions / Supabase pg_cron / 등)으로 5분 주기 호출
 * GET /api/cron/retry-agent-runs?secret=CRON_SECRET
 */
export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  // cron 인증
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  try {
    // service_role로 RLS 우회
    const supabase = (await import('@supabase/supabase-js')).createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const retryService = new AgentRetryService(supabase);
    const pending = await retryService.getAllPendingRetries();

    const results: Array<{ runId: string; status: 'retried' | 'final_failure' | 'error'; newRunId?: string }> = [];

    for (const run of pending) {
      try {
        const { newRunId } = await retryService.executeRetry(run.id);
        results.push({ runId: run.id, status: 'retried', newRunId });
      } catch {
        // 재시도 실행 실패 → max_retries 확인하여 최종 실패 판정
        const isLastRetry = run.retry_count + 1 >= run.max_retries;
        if (isLastRetry) {
          // AC3+AC4: 최종 실패 — 웹훅/슬랙 알림 발송
          await fireWebhooks(supabase, run.org_id, {
            event: 'agent_run.final_failure',
            data: {
              run_id: run.id,
              agent_id: run.agent_id,
              retry_count: run.retry_count,
              max_retries: run.max_retries,
              error_message: run.error_message,
            },
          });
          results.push({ runId: run.id, status: 'final_failure' });
        } else {
          results.push({ runId: run.id, status: 'error' });
        }
      }
    }

    // 최종 실패 run 중 아직 알림 안 간 건도 체크
    // (재시도가 성공적으로 실행됐지만 새 run이 바로 실패한 경우를 위해)
    // → 다음 cron 사이클에서 처리됨

    return apiSuccess({
      processed: results.length,
      results,
    });
  } catch (err: unknown) {
    return apiError('INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal error', 500);
  }
}
