import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode } from '@/lib/storage/factory';
import { NotFoundError } from '@sprintable/core-storage';

export type InboxAuthContext = NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;

export type InboxRouteSetup =
  | { ok: false; response: Response }
  | { ok: true; me: InboxAuthContext; dbClient: SupabaseClient | undefined };

export async function setupInboxRoute(request: Request): Promise<InboxRouteSetup> {
  const supabase = await createSupabaseServerClient();
  const me = await getAuthContext(supabase, request);
  if (!me) return { ok: false, response: ApiErrors.unauthorized() };
  if (me.rateLimitExceeded) return { ok: false, response: ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt) };

  const dbClient: SupabaseClient | undefined = isOssMode()
    ? undefined
    : (me.type === 'agent' ? createSupabaseAdminClient() : supabase);

  return { ok: true, me, dbClient };
}

export function mapInboxRepoError(err: unknown): Response {
  if (err instanceof NotFoundError) return ApiErrors.notFound(err.message);
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('already')) return apiError('CONFLICT', msg, 409);
  throw err;
}
