import { MemoService } from '@/services/memo';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { parseBody, createMemoLinkedDocSchema } from '@sprintable/shared';
import { createMemoRepository, isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

type RouteParams = { params: Promise<{ id: string }> };

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const parsed = await parseBody(request, createMemoLinkedDocSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const dbClient = isOssMode() ? undefined : (me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase);
    const repo = await createMemoRepository();
    const memoService = new MemoService(repo);
    let linkedDocId = body.doc_id ?? null;
    let createdDoc: Awaited<ReturnType<DocsService['createDoc']>> | null = null;

    if (!linkedDocId) {
      const memo = await memoService.getById(id);
      const title = body.title?.trim() || memo.title || memo.content.slice(0, 80) || 'Untitled doc';
      const slug = slugify(title) || `memo-${id.slice(0, 8)}`;
      const { createDocRepository } = await import('@/lib/storage/factory');
      const docRepo = await createDocRepository();
      const docsService = new DocsService(docRepo, dbClient as SupabaseClient | undefined);
      createdDoc = await docsService.createDoc({
        org_id: me.org_id,
        project_id: me.project_id,
        title,
        slug,
        content: body.content ?? memo.content,
        content_format: body.content_format ?? 'markdown',
        created_by: me.id,
      });
      linkedDocId = createdDoc.id;
    }

    if (!linkedDocId) {
      throw new Error('Unable to determine linked doc id');
    }

    await memoService.linkDoc(id, linkedDocId, me.id);
    const memo = await memoService.getByIdWithDetails(id);
    return apiSuccess({ memo, doc: createdDoc });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
