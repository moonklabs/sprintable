import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { PolicyDocumentService } from '@/services/policy-document';

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    if (!projectId) return ApiErrors.badRequest('project_id required');

    const service = new PolicyDocumentService(supabase);
    const docs = await service.list({
      project_id: projectId,
      sprint_id: searchParams.get('sprint_id') ?? undefined,
      q: searchParams.get('q') ?? undefined,
    });

    return apiSuccess(docs);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
