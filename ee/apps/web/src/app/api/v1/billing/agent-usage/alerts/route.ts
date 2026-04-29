import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { BillingLimitEnforcer } from '@/services/billing-limit-enforcer';
import { validateUsageMonth } from '@/services/monthly-agent-usage';
import { listMonthlyBillingLimitAlerts } from '@/services/monthly-agent-usage-dashboard';

function presentAlertLabel(alertType: string, thresholdPct: number | null) {
  if (alertType.startsWith('threshold_')) {
    return {
      kind: 'threshold',
      label: `${thresholdPct ?? 0}% threshold reached`,
    };
  }

  if (alertType === 'monthly_cap_exceeded') {
    return {
      kind: 'cap_exceeded',
      label: 'Monthly cap exceeded',
    };
  }

  return {
    kind: 'other',
    label: alertType,
  };
}

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    await requireOrgAdmin(supabase, me.org_id);

    const url = new URL(request.url);
    const monthParam = url.searchParams.get('month');
    const monthValidation = monthParam ? validateUsageMonth(monthParam) : null;
    if (monthValidation && !monthValidation.ok) return ApiErrors.badRequest(monthValidation.message);

    const enforcer = new BillingLimitEnforcer(supabase as never);
    const settings = await enforcer.getResolvedSettings(me.org_id);
    const selectedMonth = monthValidation?.month ?? new Date().toISOString().slice(0, 7);
    const usage = await enforcer.getMonthlyUsageSnapshot(me.org_id, selectedMonth);
    const alerts = await listMonthlyBillingLimitAlerts(supabase as never, {
      orgId: me.org_id,
      usageMonth: usage.usageMonth,
    });

    const thresholdAmount = settings.monthlyCapCents == null
      ? null
      : Math.ceil((settings.monthlyCapCents * settings.alertThresholdPct) / 100);

    return apiSuccess({
      org_id: me.org_id,
      usage_month: usage.usageMonth,
      scope_type: 'org',
      scope_label: 'Organization-wide budget alerts',
      project_filter_applies: false,
      month_to_date_cost_cents: usage.monthToDateCostCents,
      monthly_cap_cents: settings.monthlyCapCents,
      monthly_cap_unlimited: settings.monthlyCapCents == null,
      alert_threshold_pct: settings.alertThresholdPct,
      threshold_amount_cents: thresholdAmount,
      threshold_reached: thresholdAmount == null ? false : usage.monthToDateCostCents >= thresholdAmount,
      monthly_cap_exceeded: settings.monthlyCapCents == null ? false : usage.monthToDateCostCents > settings.monthlyCapCents,
      alerts: alerts.map((alert) => ({
        ...alert,
        ...presentAlertLabel(alert.alert_type, alert.threshold_pct),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
