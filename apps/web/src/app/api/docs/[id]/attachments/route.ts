import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/storage/config';
import { createStorageService } from '@/lib/storage/factory';

// BE _MAX_ATTACHMENT_SIZE 정합 (schemas/story.py)
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// E-FILE S4: 문서 첨부(이미지/파일)를 서버사이드에서 GCS로 업로드하고 메타({url,name,content_type,size})를 반환.
// stories/attachments 와 동형 — org/project 만 doc 에서 server-derive(클라이언트/쿠키 의존 제거).
// 반환 메타를 호출부에서 `POST /api/docs/{id}/assets` 로 register 해 assetId(ref) 를 얻는다.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const { id } = await params;
  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: { message: 'file is required' } }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return NextResponse.json({ error: { message: 'attachment too large (max 100MB)' } }, { status: 413 });
  }

  // project_id/org_id 를 doc 에서 server-side 도출(클라이언트/쿠키 의존·폴백 제거).
  // GET /api/v2/docs/{id} → doc.project_id/org_id. 인가도 BE가 강제(403/404).
  const docRes = await fetch(new URL(`/api/v2/docs/${id}`, FASTAPI_URL()).toString(), {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  });
  if (!docRes.ok) {
    return NextResponse.json({ error: { message: 'doc not found or no access' } }, { status: docRes.status === 403 ? 403 : 404 });
  }
  const doc = (await docRes.json().catch(() => null)) as { project_id?: string | null; org_id?: string | null } | null;
  const projectId = doc?.project_id;
  const orgId = doc?.org_id;
  if (!projectId || !orgId) {
    return NextResponse.json({ error: { message: 'doc org/project could not be resolved' } }, { status: 422 });
  }
  const safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-128) || 'file';
  // E-STORAGE-SSOT: org/project namespace(Storage UI 노출)·source segment(doc) 유지(IDOR scope).
  const objectPath = `org/${orgId}/project/${projectId}/doc/${id}/${randomUUID()}-${safeName}`;

  try {
    const storage = await createStorageService();
    const body = Buffer.from(await file.arrayBuffer());
    const { url } = await storage.putObject(
      GCS_MEMO_ATTACHMENTS_BUCKET,
      objectPath,
      body,
      file.type || undefined,
    );
    return NextResponse.json({
      url,
      name: file.name || safeName,
      content_type: file.type || 'application/octet-stream',
      size: file.size,
    });
  } catch (err) {
    console.error('[doc-attach] GCS upload failed', err);
    return NextResponse.json({ error: { message: 'upload failed' } }, { status: 502 });
  }
}
