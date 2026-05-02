
import type { SupabaseClient } from '@/types/supabase';
import { checkFeatureLimit } from '@/lib/check-feature';
import { apiUpgradeRequired } from '@/lib/api-response';

/**
 * API route guard: rejects with 403 UPGRADE_REQUIRED when
 * agent_orchestration is not enabled on the org's plan.
 *
 * Returns `null` when the feature is allowed, or a NextResponse to
 * short-circuit the handler.
 */
export async function requireAgentOrchestration(db: SupabaseClient, orgId: string) {
  const check = await checkFeatureLimit(db, orgId, 'agent_orchestration');
  if (!check.allowed) {
    const message = check.reason ?? 'Agent orchestration requires a Team plan or above.';
    return apiUpgradeRequired(message, 'agent_orchestration');
  }
  return null;
}
