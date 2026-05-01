import { getServerSession } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { uploadToGcs, GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/gcs';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

function resolveExtension(file: File) {
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/jpeg') return 'jpg';
  if (file.type === 'image/webp') return 'webp';
  if (file.type === 'image/gif') return 'gif';
  if (file.type === 'image/avif') return 'avif';
  return 'img';
}

function sanitizeFilename(name: string) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9가-힣._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'image';
}

export async function POST(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return ApiErrors.badRequest('file required');

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return ApiErrors.badRequest(`Unsupported image type: ${file.type}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      return ApiErrors.badRequest(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
    }

    const scope = String(formData.get('scope') ?? 'memo');
    const memoId = String(formData.get('memo_id') ?? '');
    const filename = sanitizeFilename(file.name);
    const ext = resolveExtension(file);
    const path = `memos/${scope}/${memoId || 'drafts'}/${Date.now()}-${filename}.${ext}`;

    const publicUrl = await uploadToGcs(GCS_MEMO_ATTACHMENTS_BUCKET, path, file);
    const alt = filename || 'image';

    return apiSuccess({
      path,
      publicUrl,
      markdown: `![${alt}](${publicUrl})`,
      filename: file.name,
      size: file.size,
      mime_type: file.type,
    }, undefined, 201);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
