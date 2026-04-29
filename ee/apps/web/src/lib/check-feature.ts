// @deprecated E-DATA-INTEGRITY S9: 2계층(plan_tiers/plan_features) 기반 체크 함수.
// 모든 호출 지점은 entitlement.ts의 checkEntitlement()로 전환됨.
// Phase 4에서 이 파일 및 관련 DB 테이블(plan_tiers, plan_features) 완전 제거 예정.
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getEntitlementBearingSubscription } from './billing-policy';

type OrgSubscriptionRow = {
  status?: string | null;
  tier?: string | null; // org_subscriptions.tier ('free'|'team'|'pro')
};

// 요청 내 캐싱: org_subscriptions 테이블을 한 번만 조회
const _getOrgSubscription = cache(
  (supabase: SupabaseClient, orgId: string) =>
    getEntitlementBearingSubscription<OrgSubscriptionRow>(supabase, orgId),
);

export interface FeatureCheckResult {
  allowed: boolean;
  reason?: string;
  upgradeRequired?: boolean;
}

interface OfferingFeatures {
  max_members?: number | null;
  max_projects?: number | null;
  max_stories?: number | null;
  max_docs?: number | null;
  max_mockups?: number | null;
  byoa_agents?: number | null;
  [key: string]: unknown;
}

/**
 * 조직의 구독에서 offering features 조회 (grandfathering 지원)
 * 1. subscriptions.offering_snapshot_id → plan_offering_snapshots.features (jsonb) — 구독 시점 고정
 * 2. offering_snapshot_id null (레거시 구독) → plan_features 직접 참조 폴백
 * 3. entitlement-bearing subscription이 없으면 → free tier 현행 스냅샷
 *
 * trialing 상태는 active와 동일하게 entitlement-bearing으로 취급한다.
 */
async function getOrgOfferingFeatures(supabase: SupabaseClient, orgId: string): Promise<OfferingFeatures | null> {
  const sub = await _getOrgSubscription(supabase, orgId);

  // org_subscriptions에 offering_snapshot_id 없음 → 항상 plan_features 폴백
  // sub 있으면: plan_features 직접 참조 (null 반환 → 호출자가 plan_features 코드로 감)
  // sub 없으면: free tier로 처리 (null 반환 → 호출자가 plan_features 코드로 감)
  void sub; // used for cache warming only
  return null;
}

/**
 * 조직의 요금제 티어 ID 조회 (구독 없으면 free) — 폴백용
 */
async function getOrgTierId(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const sub = await _getOrgSubscription(supabase, orgId);
  const tierName = sub?.tier ?? 'free';

  const { data: tier } = await supabase
    .from('plan_tiers')
    .select('id')
    .eq('name', tierName)
    .single();

  return tier?.id ?? null;
}

/**
 * 조직의 요금제에서 특정 기능이 허용되는지 확인 (boolean)
 * offering.features → plan_features 폴백
 */
export async function checkFeatureLimit(
  supabase: SupabaseClient,
  orgId: string,
  featureKey: string,
): Promise<FeatureCheckResult> {
  // 1. offering features에서 확인
  const features = await getOrgOfferingFeatures(supabase, orgId);
  if (features && featureKey in features) {
    const val = features[featureKey];
    if (val === false) {
      return { allowed: false, reason: `Feature "${featureKey}" is not available on your current plan. Upgrade to Team.`, upgradeRequired: true };
    }
    return { allowed: true };
  }

  // 2. plan_features 폴백
  const tierId = await getOrgTierId(supabase, orgId);
  if (!tierId) return { allowed: false, reason: 'No plan configured', upgradeRequired: true };

  const { data: feature } = await supabase
    .from('plan_features')
    .select('enabled, limit_value')
    .eq('tier_id', tierId)
    .eq('feature_key', featureKey)
    .single();

  if (!feature) return { allowed: true }; // 미설정이면 허용
  if (!feature.enabled) {
    return { allowed: false, reason: `Feature "${featureKey}" is not available on your current plan. Upgrade to Team.`, upgradeRequired: true };
  }
  return { allowed: true };
}

/**
 * 조직의 멤버 수 제한 확인
 */
export async function checkMemberLimit(
  supabase: SupabaseClient,
  orgId: string,
): Promise<FeatureCheckResult> {
  // offering features에서 max_members 확인
  const features = await getOrgOfferingFeatures(supabase, orgId);
  const maxMembers = features?.max_members;

  if (maxMembers == null) {
    // offering에 없으면 plan_tiers 폴백
    const tierId = await getOrgTierId(supabase, orgId);
    if (!tierId) return { allowed: true };

    const { data: tier } = await supabase
      .from('plan_tiers')
      .select('max_members')
      .eq('id', tierId)
      .single();

    if (!tier || tier.max_members == null) return { allowed: true };

    const { count } = await supabase
      .from('org_members')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);

    if ((count ?? 0) >= (tier.max_members as number)) {
      return { allowed: false, reason: `Member limit reached (${tier.max_members}). Upgrade to Team.`, upgradeRequired: true };
    }
    return { allowed: true };
  }

  // offering features에서 확인
  const { count } = await supabase
    .from('org_members')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);

  if ((count ?? 0) >= maxMembers) {
    return { allowed: false, reason: `Member limit reached (${maxMembers}). Upgrade to Team.`, upgradeRequired: true };
  }
  return { allowed: true };
}

/**
 * 조직의 프로젝트 수 제한 확인
 */
export async function checkProjectLimit(
  supabase: SupabaseClient,
  orgId: string,
): Promise<FeatureCheckResult> {
  const features = await getOrgOfferingFeatures(supabase, orgId);
  const maxProjects = features?.max_projects;

  if (maxProjects == null) {
    // offering에 없으면 plan_tiers 폴백
    const tierId = await getOrgTierId(supabase, orgId);
    if (!tierId) return { allowed: true };

    const { data: tier } = await supabase
      .from('plan_tiers')
      .select('max_projects')
      .eq('id', tierId)
      .single();

    if (!tier || tier.max_projects == null) return { allowed: true };

    const { count } = await supabase
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);

    if ((count ?? 0) >= (tier.max_projects as number)) {
      return { allowed: false, reason: `Project limit reached (${tier.max_projects}). Upgrade to Team.`, upgradeRequired: true };
    }
    return { allowed: true };
  }

  const { count } = await supabase
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);

  if ((count ?? 0) >= maxProjects) {
    return { allowed: false, reason: `Project limit reached (${maxProjects}). Upgrade to Team.`, upgradeRequired: true };
  }
  return { allowed: true };
}

/**
 * 제네릭 리소스 count 제한 확인 (stories, docs 등)
 * offering.features → plan_features 폴백
 */
export async function checkResourceLimit(
  supabase: SupabaseClient,
  orgId: string,
  featureKey: string,
  table: string,
  orgColumn = 'org_id',
): Promise<FeatureCheckResult> {
  // 1. offering features에서 확인
  const features = await getOrgOfferingFeatures(supabase, orgId);
  if (features && featureKey in features) {
    const limit = features[featureKey] as number | null;
    if (limit == null) return { allowed: true }; // null = 무제한

    const { count } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq(orgColumn, orgId);

    if ((count ?? 0) >= limit) {
      return { allowed: false, reason: `${featureKey} limit reached (${limit}). Upgrade to Team.`, upgradeRequired: true };
    }
    return { allowed: true };
  }

  // 2. plan_features 폴백
  const tierId = await getOrgTierId(supabase, orgId);
  if (!tierId) return { allowed: true };

  const { data: feature } = await supabase
    .from('plan_features')
    .select('enabled, limit_value')
    .eq('tier_id', tierId)
    .eq('feature_key', featureKey)
    .single();

  if (!feature) return { allowed: true };
  if (!feature.enabled) {
    return { allowed: false, reason: `Feature "${featureKey}" is not available on your current plan. Upgrade to Team.`, upgradeRequired: true };
  }
  if (feature.limit_value == null) return { allowed: true };

  const { count } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(orgColumn, orgId);

  if ((count ?? 0) >= feature.limit_value) {
    return { allowed: false, reason: `${featureKey} limit reached (${feature.limit_value}). Upgrade to Team.`, upgradeRequired: true };
  }
  return { allowed: true };
}
