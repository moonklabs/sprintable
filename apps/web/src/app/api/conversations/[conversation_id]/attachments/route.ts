import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';
import { ApiErrors } from '@/lib/api-response';
import { GCS_MEMO_ATTACHMENTS_BUCKET } from '@/lib/storage/config';
import { createStorageService } from '@/lib/storage/factory';
import { backendFetch } from '@/lib/backend-fetch';
import { fastapiBaseUrl } from '@/lib/fastapi-url';
import { ATTACHMENT_NEEDS_PROJECT } from '@/lib/chat-attachment-error';

// BE _MAX_ATTACHMENT_SIZE 정합 (conversations.py)
const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB
const FASTAPI_URL = () => fastapiBaseUrl();

// chat-attach: 파일을 서버사이드에서 GCS로 업로드하고 메시지 첨부 메타({url,name,content_type,size})를 돌려준다.
// 업로드된 GCS object URL은 리로드/다른 인스턴스에서도 유효(multi-instance safe) — BE 계약대로
// 이후 POST /api/v2/conversations/{id}/messages 의 attachments 에 그대로 실어 보낸다.
/** `org/{org}/chat/{conversation}/` or `org/{org}/project/{project}/chat/{conversation}/` — this organization's and this room's, nothing else, no dot segments */
function isThisRoomsPrefix(prefix: string, orgId: string, conversationId: string): boolean {
  if (!prefix.endsWith('/') || prefix.includes('//') || prefix.includes('\\')) return false;
  const parts = prefix.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '.' || p === '..')) return false; // a dot segment stands for another place
  const roomOnly = parts.length === 4 && parts[0] === 'org' && parts[2] === 'chat';
  const inProject = parts.length === 6 && parts[0] === 'org' && parts[2] === 'project' && parts[4] === 'chat';
  if (!roomOnly && !inProject) return false;
  return parts[1] === orgId && parts[parts.length - 1] === conversationId;
}

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
  const convRes = await backendFetch(new URL(`/api/v2/conversations/${conversation_id}`, FASTAPI_URL()).toString(), {
    request,
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  });
  if (!convRes.ok) {
    return NextResponse.json({ error: { message: 'conversation not found or no access' } }, { status: convRes.status === 403 ? 403 : 404 });
  }
  const conv = (await convRes.json().catch(() => null)) as { project_id?: string | null; org_id?: string | null; attachment_path_prefix?: string | null } | null;
  const projectId = conv?.project_id;
  const orgId = conv?.org_id;
  if (!orgId) {
    return NextResponse.json({ error: { message: 'conversation org could not be resolved' } }, { status: 422 });
  }
  // story 4847 — where the file goes is the SERVER's call once it says so (4846 PR2 · AC6: `attachment_path_prefix` on the single-room answer, built in one place for the web and the MCP
  // upload alike). Until it does, a room with a project keeps the path built here and a room with none is refused with the same code the server uses — a file must not be left in storage
  // unregistered, to be refused only at the send. The prefix is taken only when it is this organization's and this room's (the room was just read by this person: nothing else may name a path).
  const prefix = conv?.attachment_path_prefix;
  const roomPrefix = typeof prefix === 'string' && isThisRoomsPrefix(prefix, orgId, conversation_id) ? prefix : null;
  if (!projectId && !roomPrefix) {
    return NextResponse.json(
      { data: null, error: { code: ATTACHMENT_NEEDS_PROJECT, message: 'a room with no project cannot take a new attachment' }, meta: null },
      { status: 400 },
    );
  }
  const safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-128) || 'file';
  // E-STORAGE-SSOT S7: org/project namespace(Storage UI 노출)·source segment(conv) 유지(IDOR scope).
  const objectPath = roomPrefix
    ? `${roomPrefix}${randomUUID()}-${safeName}`
    : `org/${orgId}/project/${projectId}/chat/${conversation_id}/${randomUUID()}-${safeName}`;

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
