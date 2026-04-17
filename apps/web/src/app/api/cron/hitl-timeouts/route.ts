import { createClient } from '@supabase/supabase-js';
import { apiError, apiSuccess } from '@/lib/api-response';
import { AgentHitlTimeoutService } from '@/services/agent-hitl-timeout';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const service = new AgentHitlTimeoutService(supabase as never, { logger: console });
    const result = await service.scan();
    return apiSuccess(result);
  } catch (error) {
    return apiError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Internal error', 500);
  }
}
