import { NextResponse } from 'next/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** GET /api/invitations/preview?token=... — 인증 불필요, 초대 미리보기 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json(
      { error: { code: 'MISSING_TOKEN', message: '초대 토큰이 없습니다' } },
      { status: 400 },
    );
  }

  const res = await fetch(
    `${FASTAPI_URL()}/api/v2/invitations/preview?token=${encodeURIComponent(token)}`,
  ).catch(() => null);

  if (!res) {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_ERROR', message: '서버 오류가 발생했습니다' } },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const json = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    return NextResponse.json(
      { error: json?.error ?? { code: 'PREVIEW_FAILED', message: '초대 미리보기에 실패했습니다' } },
      { status: res.status },
    );
  }

  const json = await res.json() as {
    data?: {
      org_name: string;
      org_id: string;
      email: string;
      role: string;
      status: string;
      expires_at: string;
    };
  };

  const data = json.data;
  if (!data) {
    return NextResponse.json(
      { error: { code: 'INVALID_RESPONSE', message: '응답 형식 오류' } },
      { status: 502 },
    );
  }

  return NextResponse.json({
    data: {
      org_id: data.org_id,
      org_name: data.org_name,
      invited_email: data.email,
      role: data.role,
      expires_at: data.expires_at,
    },
  });
}
