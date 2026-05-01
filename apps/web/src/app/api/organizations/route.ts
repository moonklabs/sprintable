import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { z } from 'zod/v4';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

const createOrgSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).regex(/^[a-z0-9가-힣-]+$/, 'slug must be lowercase alphanumeric or Korean'),
});

// POST /api/organizations — create org + register creator as owner
export async function POST(request: Request) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json() as unknown;
    const parsed = createOrgSchema.safeParse(body);
    if (!parsed.success) {
      return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    }
    const { name, slug } = parsed.data;

    // admin client — slug 유니크 검증 시 RLS가 다른 org를 숨기는 것을 방지
    const admin = (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient());

    const { data: existingSlug } = await admin
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (existingSlug) return apiError('CONFLICT', 'Slug is already taken', 409);

    const { data: org, error: orgError } = await admin
      .from('organizations')
      .insert({ name, slug })
      .select('id, name, slug')
      .single();

    if (orgError) {
      if (orgError.code === '23505') return apiError('CONFLICT', 'Slug is already taken', 409);
      throw orgError;
    }

    // 생성자를 org_members에 owner로 등록
    const { error: memberError } = await admin
      .from('org_members')
      .insert({ org_id: org.id, user_id: user.id, role: 'owner' });

    if (memberError) throw memberError;

    return apiSuccess(org, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
