import { type NextRequest, NextResponse } from 'next/server';
import { STORAGE_PROVIDER, resolveLocalSigningSecret } from '@/lib/storage/config';
import { verifyLocalObject } from '@/lib/storage/local-sign';
import { LocalDiskStorageService } from '@/lib/storage/providers/local';

// E-STORAGE-SSOT S1 (D2): local provider 의 capability-URL serve.
//
// 이 라우트는 **신규 authz 결정을 하지 않는다**. sign 라우트(`/api/attachments/sign`)가 기존 BE
// authorize 게이트를 통과한 뒤 발급한 단기 HMAC 토큰만 검증한다(GCS V4 signed URL 과 동치).
// local provider 일 때만 활성(GCS/S3 배포에서는 404 → 표면 노출 0). range/CDN 미지원(최소 serve).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (STORAGE_PROVIDER !== 'local') {
    return NextResponse.json({ error: { message: 'not found' } }, { status: 404 });
  }

  const { path } = await params;
  if (!path || path.length < 2) {
    return NextResponse.json({ error: { message: 'invalid path' } }, { status: 400 });
  }
  const container = path[0]!;
  const objectPath = path.slice(1).join('/');

  const { searchParams } = new URL(request.url);
  const exp = Number(searchParams.get('exp'));
  const sig = searchParams.get('sig') ?? '';

  // fail-closed: prod 에서 secret 미설정이면 resolveLocalSigningSecret() 가 throw → 503(서명 검증 불가).
  let secret: string;
  try {
    secret = resolveLocalSigningSecret();
  } catch {
    return NextResponse.json(
      { error: { message: 'local storage signing not configured' } },
      { status: 503 },
    );
  }

  if (!verifyLocalObject(secret, container, objectPath, exp, sig)) {
    return NextResponse.json({ error: { message: 'invalid or expired signature' } }, { status: 403 });
  }

  const body = await new LocalDiskStorageService().readObject(container, objectPath);
  if (body === null) {
    return NextResponse.json({ error: { message: 'not found' } }, { status: 404 });
  }

  // S3: disposition(inline|attachment) — GCS responseDisposition / S3 ResponseContentDisposition 와 동치.
  const disposition = searchParams.get('disposition') === 'attachment' ? 'attachment' : 'inline';
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'cache-control': 'private, no-store',
    'content-disposition': disposition,
  };
  return new NextResponse(new Uint8Array(body), { status: 200, headers });
}
