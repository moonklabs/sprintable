// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { checkFeatureLimit } from '@/lib/check-feature';
import { apiUpgradeRequired } from '@/lib/api-response';

/**
 * API route guard: rejects with 403 UPGRADE_REQUIRED when
 * agent_orchestration is not enabled on the org's plan.
 *
 * Returns `null` when the feature is allowed, or a NextResponse to
 * short-circuit the handler.
 */
export async function requireAgentOrchestration(supabase: SupabaseClient, orgId: string) {
  const check = await checkFeatureLimit(supabase, orgId, 'agent_orchestration');
  if (!check.allowed) {
    const message = check.reason ?? 'Agent orchestration requires a Team plan or above.';
    return apiUpgradeRequired(message, 'agent_orchestration');
  }
  return null;
}
