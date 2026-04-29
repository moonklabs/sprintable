import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { ApiErrors, apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { BillingLimitEnforcer } from '@/services/billing-limit-enforcer';

const payloadSchema = z.object({
  monthly_cap_cents: z.number().int().min(0).nullable().optional(),
  daily_cap_cents: z.number().int().min(0).nullable().optional(),
  alert_threshold_pct: z.number().int().min(1).max(100).optional(),
});

function presentSettings(orgId: string, settings: Awaited<ReturnType<BillingLimitEnforcer['getResolvedSettings']>>, usage: Awaited<ReturnType<BillingLimitEnforcer['getUsageSnapshot']>>) {
  return {
    org_id: orgId,
    monthly_cap_cents: settings.monthlyCapCents,
    monthly_cap_unlimited: settings.monthlyCapCents == null,
    daily_cap_cents: settings.dailyCapCents,
    daily_cap_unlimited: settings.dailyCapCents == null,
    alert_threshold_pct: settings.alertThresholdPct,
    source: settings.source,
    tier_name: settings.tierName,
    usage_month: usage.usageMonth,
    usage_date: usage.usageDate,
    month_to_date_cost_cents: usage.monthToDateCostCents,
    day_to_date_cost_cents: usage.dayToDateCostCents,
  };
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    await requireOrgAdmin(supabase, me.org_id);

    const enforcer = new BillingLimitEnforcer(supabase as never);
    const [settings, usage] = await Promise.all([
      enforcer.getResolvedSettings(me.org_id),
      enforcer.getUsageSnapshot(me.org_id),
    ]);

    return apiSuccess(presentSettings(me.org_id, settings, usage));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    await requireOrgAdmin(supabase, me.org_id);

    const parsed = payloadSchema.safeParse(await request.json());
    if (!parsed.success) {
      return ApiErrors.validationFailed(parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })));
    }

    const enforcer = new BillingLimitEnforcer(supabase as never);
    const settings = await enforcer.saveSettings(me.org_id, {
      monthlyCapCents: parsed.data.monthly_cap_cents,
      dailyCapCents: parsed.data.daily_cap_cents,
      alertThresholdPct: parsed.data.alert_threshold_pct,
    });
    const usage = await enforcer.getUsageSnapshot(me.org_id);

    return apiSuccess(presentSettings(me.org_id, settings, usage));
  } catch (error) {
    return handleApiError(error);
  }
}
