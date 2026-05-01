// OSS stub — 실제 구현은 @moonklabs/sprintable-saas 에 있으며
// SaaS 결합 빌드 시 submodule overlay로 덮어쓴다.
// OSS 단독 빌드에서는 모든 feature gate가 allowed로 해석된다.
// @deprecated E-DATA-INTEGRITY S9: SaaS overlay의 2계층 구현은 checkEntitlement()로 전환됨.
// 이 OSS stub은 agent_orchestration/stt_recording 등 비결제 gate 용도로만 유지.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface FeatureCheckResult {
  allowed: boolean;
  reason?: string;
  upgradeRequired?: boolean;
}

export async function checkFeatureLimit(
  _supabase: SupabaseClient,
  _orgId: string,
  _feature: string,
): Promise<FeatureCheckResult> {
  return { allowed: true };
}

export async function checkMemberLimit(_supabase: SupabaseClient, _orgId: string): Promise<FeatureCheckResult> {
  return { allowed: true };
}

export async function checkProjectLimit(_supabase: SupabaseClient, _orgId: string): Promise<FeatureCheckResult> {
  return { allowed: true };
}

export async function checkResourceLimit(
  _supabase: SupabaseClient,
  _orgId: string,
  _featureKey: string,
  _table: string,
  _orgColumn: string = 'org_id',
): Promise<FeatureCheckResult> {
  return { allowed: true };
}
