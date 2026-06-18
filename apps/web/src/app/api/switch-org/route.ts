import { NextResponse } from 'next/server';
import { SP_AT_COOKIE, SP_RT_COOKIE, getServerSession } from '@/lib/db/server';
import { CURRENT_PROJECT_COOKIE } from '@/lib/auth-helpers';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const body = await request.json() as { org_id: string };
  if (!body.org_id) {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'org_id required' } }, { status: 400 });
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/switch-org`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ org_id: body.org_id }),
  });

  const json = await fastapiRes.json() as {
    data?: { access_token: string; refresh_token: string; project_id?: string };
    error?: { code: string; message: string };
  };

  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json(
      { error: json.error ?? { code: 'SWITCH_FAILED', message: `HTTP ${fastapiRes.status}` } },
      { status: fastapiRes.status },
    );
  }

  const { access_token, refresh_token, project_id } = json.data;
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  // 0746: 전환 시 current-project 쿠키를 항상 갱신해야 stale 잔존이 없다.
  // target org에 접근 가능 프로젝트가 있으면 그걸로 set, 없으면(미부여 멤버 등) 반드시 clear —
  // 안 지우면 옛 org의 project_id가 남아 get_project_scoped_org_id가 옛 org로 cross-org 해소돼
  // 다른 org 프로젝트가 노출되고 전환이 깨진다(멀티org leak).
  if (project_id) {
    res.cookies.set(CURRENT_PROJECT_COOKIE, project_id, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  } else {
    res.cookies.set(CURRENT_PROJECT_COOKIE, '', { path: '/', sameSite: 'lax', maxAge: 0 });
  }
  return res;
}
