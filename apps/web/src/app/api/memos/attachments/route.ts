import { handleApiError } from '@/lib/api-error';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

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
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'Attachments are not available in OSS mode.', 501);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden('Team member not found');

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
    const path = `memos/${me.project_id}/${scope}/${memoId || 'drafts'}/${Date.now()}-${filename}.${ext}`;

    const { error } = await supabase.storage.from('memo-attachments').upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage.from('memo-attachments').getPublicUrl(path);
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
