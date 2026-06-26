import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/storage/config';
import { createStorageService } from '@/lib/storage/factory';

// BE _MAX_ATTACHMENT_SIZE 정합 (conversations.py)
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// chat-attach: 파일을 서버사이드에서 GCS로 업로드하고 메시지 첨부 메타({url,name,content_type,size})를 돌려준다.
// 업로드된 GCS object URL은 리로드/다른 인스턴스에서도 유효(multi-instance safe) — BE 계약대로
// 이후 POST /api/v2/conversations/{id}/messages 의 attachments 에 그대로 실어 보낸다.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) return ApiErrors.unauthorized();

  const { conversation_id } = await params;
  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: { message: 'file is required' } }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return NextResponse.json({ error: { message: 'attachment too large (max 100MB)' } }, { status: 413 });
  }

  // 03fe1663: project_id를 conversation에서 server-side 도출(클라이언트/쿠키 의존·'unknown' 폴백 제거).
  // #1299 GET /api/v2/conversations/{id} → conversation.project_id. 인가도 BE가 강제(403/404).
  const convRes = await fetch(new URL(`/api/v2/conversations/${conversation_id}`, FASTAPI_URL()).toString(), {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  });
  if (!convRes.ok) {
    return NextResponse.json({ error: { message: 'conversation not found or no access' } }, { status: convRes.status === 403 ? 403 : 404 });
  }
  const conv = (await convRes.json().catch(() => null)) as { project_id?: string | null } | null;
  const projectId = conv?.project_id;
  if (!projectId) {
    return NextResponse.json({ error: { message: 'conversation project could not be resolved' } }, { status: 422 });
  }
  const safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-128) || 'file';
  const objectPath = `chat/${projectId}/${conversation_id}/${randomUUID()}-${safeName}`;

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
    console.error('[chat-attach] GCS upload failed', err);
    return NextResponse.json({ error: { message: 'upload failed' } }, { status: 502 });
  }
}
