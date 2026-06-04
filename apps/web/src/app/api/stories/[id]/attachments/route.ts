import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { GCS_MEMO_ATTACHMENTS_BUCKET, uploadToGcs } from '@/lib/gcs';

// BE _MAX_ATTACHMENT_SIZE 정합 (schemas/story.py)
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB

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

  const projectId = (formData.get('project_id') as string | null) ?? 'unknown';
  const safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-128) || 'file';
  const objectPath = `story/${projectId}/${id}/${randomUUID()}-${safeName}`;

  try {
    const url = await uploadToGcs(GCS_MEMO_ATTACHMENTS_BUCKET, objectPath, file);
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
