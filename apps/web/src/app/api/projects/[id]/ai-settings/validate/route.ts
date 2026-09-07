import { z } from 'zod';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
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
    const rawBody = await request.json().catch(() => null);
    const parsed = validateKeySchema.safeParse(rawBody);
    if (!parsed.success) return ApiErrors.badRequest(parsed.error.issues.map((i) => i.message).join(', '));
    const { provider, api_key, base_url } = parsed.data;
    const normalizedBaseUrl = base_url?.trim() ? validateCustomEndpoint(base_url, provider) : undefined;
    const status = await testProviderKey(provider, api_key, normalizedBaseUrl);
    return apiSuccess({ status, project_id: id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// story #3644(3632 후속, 유나 v3.1 목록 즉시 결함) — 정상 경로는 `res.status !== 401/403`
// 인데, 아래 catch가 네트워크 실패·타임아웃(AbortSignal.timeout(10s))·DNS 오류까지 전부
// false 하나로 수렴시켰다. false는 화면에서 "키가 유효하지 않다"로 읽히는데 실제로는
// "검증하지 못했다"다 — 사용자가 멀쩡한 키를 버리고 새로 발급하러 가는 오독(doc §1
// "모름을 아님으로"). valid/invalid/unknown 세 값으로 가른다.
async function testProviderKey(provider: LLMProvider, apiKey: string, baseUrl?: string): Promise<'valid' | 'invalid' | 'unknown'> {
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
    if (!config) return 'invalid';

    if (provider === 'anthropic') {
      const res = await fetch(config.url, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      });
      return res.status === 401 || res.status === 403 ? 'invalid' : 'valid';
    }

    const res = await fetch(config.url, {
      method: 'GET',
      headers: config.headers,
      signal: AbortSignal.timeout(10000),
    });

    return res.status === 401 || res.status === 403 ? 'invalid' : 'valid';
  } catch {
    // 네트워크 실패·타임아웃·DNS 오류 — 상류가 401/403을 정직하게 answer하지 못했다.
    // "invalid"가 아니라 "unknown"이다.
    return 'unknown';
  }
}
