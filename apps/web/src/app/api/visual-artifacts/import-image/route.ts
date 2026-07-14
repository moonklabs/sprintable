import { randomUUID } from 'node:crypto';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/storage/config';
import { createStorageService } from '@/lib/storage/factory';

const MAX_IMPORT_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB — 첨부(100MB)보다 보수적, 임포트는 시안 스크린샷 용도

/**
 * story 64010b05(E-CANVAS C5 v1) — 이미지 임포트. `stories/[id]/attachments`와 동형 패턴(서버사이드
 * GCS 업로드, 신규 BE 0) — 다만 스토리 소속 조회가 필요 없어(임포트 시점엔 아직 artifact/story
 * 연결 전) `getAuthContext`로 org/project를 직접 얻는다(기존 visual-artifacts 라우트와 동일 관례).
 * 새 GCS 버킷 발급은 이 low 스토리 스코프 밖 — 기존 memo-attachments 버킷을 canvas-import
 * object path 프리픽스로 구분해 재사용(신규 인프라 0).
 */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return apiError('VALIDATION_ERROR', 'file is required', 400);
    if (file.size > MAX_IMPORT_IMAGE_SIZE) return apiError('VALIDATION_ERROR', 'image too large (max 20MB)', 413);
    if (!file.type.startsWith('image/')) return apiError('VALIDATION_ERROR', 'file must be an image', 400);

    const safeName = (file.name || 'image').replace(/[^\w.-]+/g, '_').slice(-128) || 'image';
    const objectPath = `org/${me.org_id}/project/${me.project_id}/canvas-import/${randomUUID()}-${safeName}`;

    const storage = await createStorageService();
    const body = Buffer.from(await file.arrayBuffer());
    const { url } = await storage.putObject(GCS_MEMO_ATTACHMENTS_BUCKET, objectPath, body, file.type);
    return apiSuccess({ url });
  } catch (err: unknown) { return handleApiError(err); }
}
