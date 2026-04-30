import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { checkFeatureLimit } from '@/lib/check-feature';
import { uploadToGcs, GCS_RECORDINGS_BUCKET } from '@/lib/gcs';

type RouteParams = { params: Promise<{ id: string }> };

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/wav',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
]);

/** POST — 녹음 파일 업로드 (multipart/form-data). STT 사용량은 /transcribe에서만 적재. */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const me = await getAuthContext(supabase, request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = me.type === 'agent' ? createSupabaseAdminClient() : supabase;

    // AC9: Feature gating — 녹음 기능 티어 검증
    const featureCheck = await checkFeatureLimit(dbClient, me.org_id, 'stt_recording');
    if (!featureCheck.allowed) {
      return ApiErrors.forbidden(featureCheck.reason ?? 'Recording not available on your plan');
    }

    const formData = await request.formData();
    const file = formData.get('audio') as File | null;
    if (!file) return ApiErrors.badRequest('audio file required');

    // AC8: 파일 크기 검증
    if (file.size > MAX_FILE_SIZE) {
      return ApiErrors.badRequest(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
    }

    // AC8: MIME 타입 검증
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return ApiErrors.badRequest(
        `Unsupported audio format: ${file.type}. Supported: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    const ext = file.type.includes('webm') ? 'webm'
      : file.type.includes('wav') ? 'wav'
      : file.type.includes('mp4') ? 'mp4'
      : file.type.includes('mpeg') ? 'mp3'
      : 'ogg';
    const path = `meetings/${id}/${Date.now()}.${ext}`;

    const publicUrl = await uploadToGcs(GCS_RECORDINGS_BUCKET, path, file);

    await dbClient.from('meetings').update({ recording_url: publicUrl }).eq('id', id);

    return apiSuccess({ path, publicUrl });
  } catch (err: unknown) { return handleApiError(err); }
}
