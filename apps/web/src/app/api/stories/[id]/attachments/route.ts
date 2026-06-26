import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/storage/config';
import { createStorageService } from '@/lib/storage/factory';

// BE _MAX_ATTACHMENT_SIZE 정합 (schemas/story.py)
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// E-FILE S4: 스토리 첨부 파일을 서버사이드에서 GCS로 업로드하고 메타({url,name,content_type,size})를 반환.
// chat-attach 의 conversations/attachments 와 동형. 반환 메타를 호출부에서 모아
// PATCH /api/stories/{id} {attachments: [...전체...]} (전체 교체) 로 저장한다.
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

  // 03fe1663: project_id를 story에서 server-side 도출(클라이언트/쿠키 의존·'unknown' 폴백 제거).
  // GET /api/v2/stories/{id} → story.project_id. 인가도 BE가 강제(403/404).
  const storyRes = await fetch(new URL(`/api/v2/stories/${id}`, FASTAPI_URL()).toString(), {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  });
  if (!storyRes.ok) {
    return NextResponse.json({ error: { message: 'story not found or no access' } }, { status: storyRes.status === 403 ? 403 : 404 });
  }
  const story = (await storyRes.json().catch(() => null)) as { project_id?: string | null; org_id?: string | null } | null;
  const projectId = story?.project_id;
  const orgId = story?.org_id;
  if (!projectId || !orgId) {
    return NextResponse.json({ error: { message: 'story org/project could not be resolved' } }, { status: 422 });
  }
  const safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-128) || 'file';
  // E-STORAGE-SSOT S7: org/project namespace(Storage UI 노출)·source segment(story) 유지(IDOR scope).
  const objectPath = `org/${orgId}/project/${projectId}/story/${id}/${randomUUID()}-${safeName}`;

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
    console.error('[story-attach] GCS upload failed', err);
    return NextResponse.json({ error: { message: 'upload failed' } }, { status: 502 });
  }
}
