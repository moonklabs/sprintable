import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkUsage, incrementUsage } from '@/lib/usage-check';
import { createLLMClient, resolveLLMConfig, type LLMProvider } from '@/lib/llm';

export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are a meeting note structurer. Given a raw meeting transcript, extract:
1. A concise summary (2-4 paragraphs)
2. Key decisions made (with owner if mentioned)
3. Action items (with assignee and due date if mentioned)

Respond in valid JSON:
{
  "summary": "...",
  "decisions": [{"id": "d1", "text": "...", "owner": "..."}],
  "action_items": [{"id": "a1", "text": "...", "assignee": "...", "due_date": "...", "status": "todo"}]
}

Use the same language as the transcript. Be concise and accurate.`;

// POST /api/meetings/:id/summary — JSON response (agent-facing, non-SSE)
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;

    const usageCheck = await checkUsage(dbClient, me.org_id, 'ai_calls');
    if (!usageCheck.allowed) return ApiErrors.badRequest(`AI calls limit reached (${usageCheck.currentValue}/${usageCheck.limitValue})`);

    const body = await request.json().catch(() => ({})) as {
      provider?: LLMProvider;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
      projectId?: string;
      rawTranscript?: string;
    };

    const projectId = body.projectId ?? me.project_id;
    const rawTranscript = body.rawTranscript;
    if (!rawTranscript) return ApiErrors.badRequest('No transcript available');

    const llmConfig = await resolveLLMConfig(projectId, body);
    if (!llmConfig) return ApiErrors.badRequest('No AI API key configured');

    const llm = createLLMClient(llmConfig);
    const response = await llm.generate([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Meeting transcript:\n\n${rawTranscript}` },
    ], { responseFormat: 'json_object' });

    let parsed: { summary?: string; decisions?: unknown[]; action_items?: unknown[] } = {};
    try { parsed = JSON.parse(response.text); } catch { parsed = { summary: response.text, decisions: [], action_items: [] }; }

    await incrementUsage(dbClient, me.org_id, 'ai_calls');

    return apiSuccess({
      meeting_id: id,
      summary: parsed.summary ?? response.text,
      decisions: parsed.decisions ?? [],
      action_items: parsed.action_items ?? [],
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
