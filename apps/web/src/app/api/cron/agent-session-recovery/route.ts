import { createClient } from '@supabase/supabase-js';
import { apiError, apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { AgentSessionLifecycleService } from '@/services/agent-session-lifecycle';
import { resumeSessionCandidates } from '@/services/agent-session-resume';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const service = new AgentSessionLifecycleService(supabase as never);
    const result = await service.recoverStaleRuns();
    if (result.resumeCandidates.length > 0) {
      await resumeSessionCandidates(supabase as never, result.resumeCandidates);
    }
    return apiSuccess({
      recoveredCount: result.recoveredCount,
      retryScheduledCount: result.retryScheduledCount,
      terminatedCount: result.terminatedCount,
      resumedCount: result.resumedCount,
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Internal error', 500);
  }
}
