import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { z } from 'zod/v4';

const createOrgSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).regex(/^[a-z0-9가-힣-]+$/, 'slug must be lowercase alphanumeric or Korean'),
});

// POST /api/organizations — create org + register creator as owner
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const body = await request.json() as unknown;
    const parsed = createOrgSchema.safeParse(body);
    if (!parsed.success) {
      return apiError('VALIDATION_ERROR', JSON.stringify(parsed.error.issues), 400);
    }
    const { name, slug } = parsed.data;

    // slug 유니크 검증
    const { data: existingSlug } = await supabase
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (existingSlug) return apiError('CONFLICT', 'Slug is already taken', 409);

    // service_role로 INSERT (RLS bypass — 인증 확인은 위에서 완료)
    const admin = createSupabaseAdminClient();

    const { data: org, error: orgError } = await admin
      .from('organizations')
      .insert({ name, slug })
      .select('id, name, slug')
      .single();

    if (orgError) throw orgError;

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
