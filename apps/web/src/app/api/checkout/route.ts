import { Polar } from '@polar-sh/sdk';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isOssMode } from '@/lib/storage/factory';
import { z } from 'zod';

const bodySchema = z.object({
  product_id: z.string().min(1),
});

export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Billing is not available in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return ApiErrors.badRequest('Invalid product_id');

    const { data: orgMember } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const polar = new Polar({
      accessToken: process.env['POLAR_ACCESS_TOKEN'] ?? '',
      serverURL: process.env['POLAR_SERVER_URL'] ?? 'https://api.polar.sh',
    });

    const appUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? '';
    const checkout = await polar.checkouts.create({
      products: [parsed.data.product_id],
      successUrl: `${appUrl}/upgrade/success`,
      embedOrigin: appUrl,
      customerEmail: user.email ?? undefined,
      metadata: orgMember?.org_id ? { org_id: orgMember.org_id } : undefined,
    });

    return apiSuccess({ url: checkout.url });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
