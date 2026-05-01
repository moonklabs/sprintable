import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiUpgradeRequired, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkUsage, incrementUsage, getThresholdAlert } from '@/lib/usage-check';
import { NotificationService } from '@/services/notification.service';
import {
  createLLMClient,
  LLMAuthError,
  LLMTimeoutError,
  LLMTokenLimitError,
  resolveLLMConfig,
  type LLMProvider,
} from '@/lib/llm';

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

/**
 * POST /api/meetings/:id/summarize
 *
 * 기존 직접 OpenAI/Anthropic 호출을 LLM 추상화 레이어로 교체.
 * 응답 형식은 기존 프론트 훅과 호환되도록 SSE 유지.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    const usageCheck = await checkUsage(dbClient, me.org_id, 'ai_calls');
    if (!usageCheck.allowed) {
      return apiUpgradeRequired(
        `AI calls limit reached (${usageCheck.currentValue}/${usageCheck.limitValue})`,
        'ai_calls',
      );
    }

    const { data: meeting } = await dbClient
      .from('meetings')
      .select('id, raw_transcript, project_id')
      .eq('id', id)
      .single();

    if (!meeting) return ApiErrors.notFound();
    if (!meeting.raw_transcript) return ApiErrors.badRequest('NO_TRANSCRIPT');

    const body = await request.json().catch(() => ({})) as {
      provider?: LLMProvider;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      timeoutMs?: number;
      maxRetries?: number;
    };

    const llmConfig = await resolveLLMConfig(meeting.project_id, body);
    if (!llmConfig) return ApiErrors.badRequest('NO_API_KEY');

    const llm = createLLMClient(llmConfig);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = await llm.generate([
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Meeting transcript:\n\n${meeting.raw_transcript}` },
          ], { responseFormat: 'json_object' });

          if (response.text) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: response.text })}\n\n`));
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage: response.usage })}\n\n`));

          let parsed: { summary?: string; decisions?: unknown[]; action_items?: unknown[] } = {};
          try {
            parsed = JSON.parse(response.text);
          } catch {
            parsed = { summary: response.text, decisions: [], action_items: [] };
          }

          const { error: updateErr } = await dbClient
            .from('meetings')
            .update({
              ai_summary: parsed.summary ?? response.text,
              decisions: parsed.decisions ?? [],
              action_items: parsed.action_items ?? [],
            })
            .eq('id', id);

          await dbClient.from('ai_usage').insert({
            org_id: me.org_id,
            project_id: meeting.project_id,
            feature_key: 'ai_structuring',
            meeting_id: id,
          });

          await incrementUsage(dbClient, me.org_id, 'ai_calls');
          const postUsage = await checkUsage(dbClient, me.org_id, 'ai_calls');
          const alert = getThresholdAlert(postUsage.percentage);
          if (alert) {
            new NotificationService(dbClient).create({
              org_id: me.org_id,
              user_id: me.id,
              type: 'warning',
              title: alert === 'limit_reached' ? 'AI calls limit reached' : `AI calls at ${postUsage.percentage}%`,
              body: `${postUsage.currentValue}/${postUsage.limitValue} used`,
              reference_type: 'usage',
            }).catch(() => {});
          }

          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              summary: parsed.summary ?? response.text,
              decisions: parsed.decisions ?? [],
              action_items: parsed.action_items ?? [],
              error: updateErr?.message ?? null,
            })}\n\n`,
          ));
        } catch (error) {
          let message = 'AI structuring failed';
          if (error instanceof LLMAuthError) message = 'LLMAuthError';
          else if (error instanceof LLMTimeoutError) message = 'LLMTimeoutError';
          else if (error instanceof LLMTokenLimitError) message = 'LLMTokenLimitError';
          else if (error instanceof Error) message = error.message;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
