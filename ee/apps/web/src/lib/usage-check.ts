import type { SupabaseClient } from '@supabase/supabase-js';

import { getEntitlementBearingSubscription } from './billing-policy';

export interface UsageCheckResult {
  allowed: boolean;
  currentValue: number;
  limitValue: number | null;
  percentage: number;  // 0-100
  meterType: string;
}

/**
 * AC2+AC3: Usage 체크 미들웨어
 * - 현재 월의 미터 조회 또는 자동 생성
 * - 한도 초과 시 { allowed: false }
 */
export async function checkUsage(
  supabase: SupabaseClient,
  orgId: string,
  meterType: string,
): Promise<UsageCheckResult> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  // 현재 월 미터 조회
  const { data: meter } = await supabase
    .from('usage_meters')
    .select('current_value, limit_value')
    .eq('org_id', orgId)
    .eq('meter_type', meterType)
    .gte('period_start', periodStart.toISOString())
    .lte('period_end', periodEnd.toISOString())
    .maybeSingle();

  const currentValue = meter?.current_value ?? 0;
  const limitValue = meter?.limit_value ?? null;
  const percentage = limitValue ? Math.round((currentValue / limitValue) * 100) : 0;

  if (limitValue != null && currentValue >= limitValue) {
    return { allowed: false, currentValue, limitValue, percentage: 100, meterType };
  }

  return { allowed: true, currentValue, limitValue, percentage, meterType };
}

/** tier 기반 limit_value 조회 */
async function getTierLimit(supabase: SupabaseClient, orgId: string, meterType: string): Promise<number | null> {
  // meter_type → plan_features feature_key 매핑
  const METER_TO_FEATURE: Record<string, string> = {
    ai_calls: 'ai_structuring_monthly_limit',
    stt_minutes: 'max_stt_minutes',
    members: 'max_members',
    agents: 'byoa_agents',
    storage_mb: 'max_storage_mb',
  };
  const featureKey = METER_TO_FEATURE[meterType];
  if (!featureKey) return null;

  const sub = await getEntitlementBearingSubscription<{ tier?: string | null; status?: string | null }>(
    supabase,
    orgId,
  );
  const tierName = sub?.tier ?? 'free';
  const { data: tierRow } = await supabase.from('plan_tiers').select('id').eq('name', tierName).single();
  const tierId = tierRow?.id ?? null;
  if (!tierId) return null;

  const { data: feat } = await supabase
    .from('plan_features').select('limit_value').eq('tier_id', tierId).eq('feature_key', featureKey).single();
  return feat?.limit_value ?? null;
}

/**
 * AC2: Usage 증가 (increment)
 * - 미터 없으면 자동 생성 (tier 기반 limit 자동 주입)
 */
export async function incrementUsage(
  supabase: SupabaseClient,
  orgId: string,
  meterType: string,
  increment = 1,
): Promise<void> {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const { data: existing } = await supabase
    .from('usage_meters')
    .select('id, current_value')
    .eq('org_id', orgId)
    .eq('meter_type', meterType)
    .gte('period_start', periodStart.toISOString())
    .maybeSingle();

  if (existing) {
    await supabase
      .from('usage_meters')
      .update({
        current_value: existing.current_value + increment,
        updated_at: now.toISOString(),
      })
      .eq('id', existing.id);
  } else {
    // tier 기반 limit 자동 주입
    const limitValue = await getTierLimit(supabase, orgId, meterType);
    await supabase
      .from('usage_meters')
      .insert({
        org_id: orgId,
        meter_type: meterType,
        current_value: increment,
        limit_value: limitValue,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
      });
  }
}

/**
 * AC6: threshold 알림 체크 (80%/90%/100%)
 */
export function getThresholdAlert(percentage: number): 'warning_80' | 'warning_90' | 'limit_reached' | null {
  if (percentage >= 100) return 'limit_reached';
  if (percentage >= 90) return 'warning_90';
  if (percentage >= 80) return 'warning_80';
  return null;
}
