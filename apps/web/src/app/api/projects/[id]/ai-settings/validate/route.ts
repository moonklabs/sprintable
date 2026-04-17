import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { validateCustomEndpoint } from '@/lib/llm/config';
import type { LLMProvider } from '@/lib/llm';

type RouteParams = { params: Promise<{ id: string }> };

const validateKeySchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'groq', 'openai-compatible']),
  api_key: z.string().trim().min(1, 'api_key is required'),
  base_url: z.string().trim().optional().or(z.literal('')),
}).superRefine((value, ctx) => {
  if (value.provider === 'openai-compatible' && !value.base_url?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['base_url'],
      message: 'base_url is required for openai-compatible provider',
    });
  }
});

/** POST — validate a BYOM API key by making a lightweight provider call */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const rawBody = await request.json();
    const parsed = validateKeySchema.safeParse(rawBody);
    if (!parsed.success) {
      return ApiErrors.badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    }

    const { provider, api_key, base_url } = parsed.data;
    const normalizedBaseUrl = base_url?.trim() ? validateCustomEndpoint(base_url, provider) : undefined;
    const valid = await testProviderKey(provider, api_key, normalizedBaseUrl);

    return apiSuccess({ valid, project_id: id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

async function testProviderKey(provider: LLMProvider, apiKey: string, baseUrl?: string): Promise<boolean> {
  try {
    const endpoints: Record<string, { url: string; headers: Record<string, string> }> = {
      openai: {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      anthropic: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      },
      google: {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': apiKey },
      },
      groq: {
        url: 'https://api.groq.com/openai/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      'openai-compatible': {
        url: `${baseUrl ?? 'https://api.openai.com/v1'}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    };

    const config = endpoints[provider];
    if (!config) return false;

    // For Anthropic, we need a POST with minimal payload to test auth
    if (provider === 'anthropic') {
      const res = await fetch(config.url, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      });
      // 200 = valid, 401/403 = invalid key, other errors = might be valid but service issue
      return res.status !== 401 && res.status !== 403;
    }

    const res = await fetch(config.url, {
      method: 'GET',
      headers: config.headers,
      signal: AbortSignal.timeout(10000),
    });

    return res.status !== 401 && res.status !== 403;
  } catch {
    // Network errors — treat as potentially valid (service might be down)
    return false;
  }
}
