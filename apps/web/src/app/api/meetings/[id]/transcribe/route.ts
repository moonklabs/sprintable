import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiUpgradeRequired, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkFeatureLimit } from '@/lib/check-feature';
import { checkUsage, incrementUsage, getThresholdAlert } from '@/lib/usage-check';
import { NotificationService } from '@/services/notification.service';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['audio/webm', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'audio/ogg']);

/**
 * POST /api/meetings/:id/transcribe
 *
 * AC4+AC6: 서버 사이드 STT — 업로드 파일을 Whisper API로 전사
 * Web Speech API는 마이크 전용이므로, 파일 업로드 STT는 서버 경유 필수
 *
 * env: OPENAI_API_KEY (서버 관리형) 또는 request body의 apiKey (BYOM)
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()) : supabase;

    // AC2+AC3: usage meter 체크 (통합 게이팅+쿼오타 체크)
    const usageCheck = await checkUsage(dbClient, me.org_id, 'stt_minutes');
    if (!usageCheck.allowed) {
      return apiUpgradeRequired(
        `STT limit reached (${usageCheck.currentValue}/${usageCheck.limitValue} min)`,
        'stt_minutes',
      );
    }

    // AC9: STT 분 쿼터 체크
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const { data: usageRows } = await dbClient
      .from('stt_usage')
      .select('duration_sec')
      .eq('org_id', me.org_id)
      .gte('created_at', startOfMonth.toISOString());
    const monthlyMinutes = Math.ceil(
      (usageRows ?? []).reduce((sum: number, r: { duration_sec: number }) => sum + r.duration_sec, 0) / 60,
    );

    // AC9: STT minute quota — checkFeatureLimit 경유 (SaaS overlay에서 org_subscriptions 기반 검증)
    const quotaCheck = await checkFeatureLimit(dbClient, me.org_id, 'max_stt_minutes');
    if (!quotaCheck.allowed) {
      return apiUpgradeRequired(`Monthly STT limit reached (${monthlyMinutes} min)`, 'stt_minutes');
    }

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;
    if (!file) return ApiErrors.badRequest('audio file required');

    if (file.size > MAX_FILE_SIZE) {
      return ApiErrors.badRequest(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return ApiErrors.badRequest(`Unsupported format: ${file.type}`);
    }

    // BYOM: 클라이언트가 API key를 보내면 사용, 아니면 서버 env
    const byomKey = formData.get('apiKey') as string | null;
    const apiKey = byomKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return ApiErrors.badRequest('No STT API key configured. Set OPENAI_API_KEY or provide apiKey.');
    }

    // Whisper API 호출
    const whisperForm = new FormData();
    whisperForm.append('file', file, 'recording.webm');
    whisperForm.append('model', 'whisper-1');
    const lang = (formData.get('language') as string | null) ?? 'ko';
    whisperForm.append('language', lang.split('-')[0]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const errBody = await whisperRes.json().catch(() => ({}));
      const msg = (errBody as { error?: { message?: string } })?.error?.message ?? `Whisper API error: ${whisperRes.status}`;
      return ApiErrors.badRequest(msg);
    }

    const result = (await whisperRes.json()) as { text: string; duration?: number };

    // raw_transcript 저장
    await dbClient.from('meetings').update({ raw_transcript: result.text }).eq('id', id);

    // AC9: 사용량 기록
    const durationSec = result.duration ? Math.ceil(result.duration) : Math.max(60, Math.ceil(file.size / (1024 * 1024)) * 60);
    await dbClient.from('stt_usage').insert({
      org_id: me.org_id,
      meeting_id: id,
      duration_sec: durationSec,
      provider: 'whisper',
    });

    // AC2: usage meter 증가 + AC6: threshold 알림
    await incrementUsage(dbClient, me.org_id, 'stt_minutes', Math.ceil(durationSec / 60));
    const postUsage = await checkUsage(dbClient, me.org_id, 'stt_minutes');
    const alert = getThresholdAlert(postUsage.percentage);
    if (alert) {
      new NotificationService(dbClient).create({
        org_id: me.org_id,
        user_id: me.id,
        type: 'warning',
        title: alert === 'limit_reached' ? 'STT limit reached' : `STT usage at ${postUsage.percentage}%`,
        body: `${postUsage.currentValue}/${postUsage.limitValue} min used`,
        reference_type: 'usage',
      }).catch(() => {});
    }

    return apiSuccess({
      text: result.text,
      duration_sec: durationSec,
      usage: { monthlyMinutes: monthlyMinutes + Math.ceil(durationSec / 60) },
    });
  } catch (err: unknown) { return handleApiError(err); }
}
