import { NextResponse } from 'next/server';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { isOssMode } from '@/lib/storage/factory';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function cookieBase() {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) };
}

/** POST /api/auth/register */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const body = await request.json() as { email: string; password: string; name?: string };

  if (isOssMode()) {
    const { getDb, OSS_ORG_ID, OSS_PROJECT_ID } = await import('@sprintable/storage-pglite');
    const { hashPassword, signOssSession, ossSessionCookieOptions, OSS_SESSION_COOKIE } = await import('@/lib/oss-auth');
    const { randomUUID } = await import('node:crypto');
    const db = await getDb();

    const email = body.email?.trim().toLowerCase();
    const name = (body.name?.trim()) || email.split('@')[0] || 'User';
    const password = body.password;

    if (!email || !password) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'email and password are required' } }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' } }, { status: 400 });
    }

    const existing = (await db.query('SELECT id FROM oss_users WHERE email = $1 LIMIT 1', [email])).rows[0];
    if (existing) {
      return NextResponse.json({ error: { code: 'CONFLICT', message: 'Email already registered' } }, { status: 409 });
    }

    const now = new Date().toISOString();
    const userId = randomUUID();
    const passwordHash = hashPassword(password);

    await db.query(
      'INSERT INTO oss_users (id, email, password_hash, name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
      [userId, email, passwordHash, name, now]
    );

    // Count after insert to determine role (1 = first user → owner).
    const countRow = (await db.query('SELECT COUNT(*) as cnt FROM oss_users')).rows[0] as { cnt: string | number };
    const isFirst = Number(countRow.cnt) <= 1;
    const role = isFirst ? 'owner' : 'member';

    const projects = (await db.query(
      'SELECT id, org_id FROM projects WHERE deleted_at IS NULL ORDER BY created_at ASC'
    )).rows as Array<{ id: string; org_id: string }>;
    const targetProjects = projects.length > 0 ? projects : [{ id: OSS_PROJECT_ID, org_id: OSS_ORG_ID }];

    for (const project of targetProjects) {
      const memberId = randomUUID();
      await db.query(
        'INSERT INTO team_members (id, org_id, project_id, user_id, name, email, role, type, is_active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9)',
        [memberId, project.org_id, project.id, userId, name, email, role, 'human', now]
      );
    }

    const token = await signOssSession(userId);
    const res = NextResponse.json({ data: { ok: true } }, { status: 201 });
    res.cookies.set(OSS_SESSION_COOKIE, token, ossSessionCookieOptions());
    return res;
  }

  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string; token_type: string }; error?: { code: string; message: string } };
  if (!fastapiRes.ok || !json.data) {
    return NextResponse.json({ error: json.error ?? { code: 'REGISTER_FAILED', message: 'Registration failed' } }, { status: fastapiRes.status });
  }

  const { access_token, refresh_token } = json.data;
  const res = NextResponse.json({ data: { ok: true } }, { status: 201 });
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: 15 * 60 });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  return res;
}
