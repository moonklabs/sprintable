import { Polar } from '@polar-sh/sdk';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';

// POST /api/billing/portal — create a Polar Customer Portal session URL
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();

    const { data: sub } = await supabase
      .from('org_subscriptions')
      .select('polar_customer_id')
      .eq('org_id', me.org_id)
      .maybeSingle();

    if (!sub?.polar_customer_id) {
      return ApiErrors.badRequest('No active Polar subscription found');
    }

    const isSandbox = (process.env['POLAR_SERVER_URL'] ?? '').includes('sandbox');
    const polar = new Polar({
      accessToken: process.env['POLAR_ACCESS_TOKEN'],
      server: isSandbox ? 'sandbox' : 'production',
    });

    const session = await polar.customerSessions.create({
      customerId: sub.polar_customer_id,
    });

    const portalBase = isSandbox
      ? 'https://sandbox.polar.sh'
      : 'https://polar.sh';
    const url = `${portalBase}/login?customer_session_token=${session.token}`;

    return apiSuccess({ url });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
