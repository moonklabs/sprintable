import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DocsService } from '@/services/docs';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { isOssMode, createDocRepository } from '@/lib/storage/factory';

/**
 * Extract all doc IDs referenced by page-embed nodes from an HTML string.
 */
function extractEmbedIds(html: string | null | undefined): string[] {
  if (!html) return [];
  const ids: string[] = [];
  const regex = /data-doc-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * BFS over the embed graph starting from `startDocId`, collecting all
 * transitively-embedded doc IDs (up to `maxDepth` hops).
 * Used to detect indirect circular embeds (A→B→A).
 */
async function collectTransitiveEmbeds(
  supabase: SupabaseClient,
  projectId: string,
  startDocId: string,
  maxDepth = 5,
): Promise<string[]> {
  const visited = new Set<string>([startDocId]);
  const chain: string[] = [];
  let frontier = [startDocId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const { data } = await supabase
      .from('docs')
      .select('id, content')
      .eq('project_id', projectId)
      .in('id', frontier);

    if (!data?.length) break;

    const nextFrontier: string[] = [];
    for (const doc of data) {
      for (const id of extractEmbedIds(doc.content)) {
        if (!visited.has(id)) {
          visited.add(id);
          chain.push(id);
          nextFrontier.push(id);
        }
      }
    }
    frontier = nextFrontier;
  }

  return chain;
}

/**
 * GET /api/docs/preview?q=<slug-or-uuid>
 */
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded)
      return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const ossMode = isOssMode();
    const dbClient = ossMode ? undefined : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    if (!q) return ApiErrors.badRequest('q is required');

    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient as SupabaseClient | undefined);
    const doc = await service.getDocPreview(me.project_id, q);
    if (!doc) return ApiErrors.notFound('Document not found');

    // OSS: skip embed chain traversal (no raw Supabase client available)
    const embedChain = dbClient ? await collectTransitiveEmbeds(dbClient, me.project_id, doc.id) : [];

    return apiSuccess({
      id: doc.id,
      title: doc.title,
      icon: doc.icon ?? null,
      slug: doc.slug,
      embedChain,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
