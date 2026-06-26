import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { handleApiError } from '@/lib/api-error';
import { getServerSession, SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import {
  auditVault,
  decodeAccountId,
  discardActiveSession,
  discardCookies,
  getVerifiedActiveAccountId,
} from '@/lib/auth/account-vault';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

interface AccountMeta {
  account_id: string;
  name: string | null;
  email: string | null;
  org_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'expired';
}

/**
 * GET /api/accounts — switcher 계정 리스트(ⓐ). vault+active RT는 서버 경계 안에서만 BE resolve.
 * RC1 enforcement: corrupt active(sp_at.sub != sp_rt.sub) = 폐기+401 거부 / stale vault = 폐기.
 * RC3: resolve는 metadata만(rotate/revoke 부작용 0). BE 404 = RT decode 최소 리스트(graceful).
 */
export async function GET(_request: Request) {
  try {
    const store = await cookies();
    const at = store.get(SP_AT_COOKIE)?.value ?? null;
    const activeRt = store.get(SP_RT_COOKIE)?.value ?? null;
    const activeId = await getVerifiedActiveAccountId();
    const { valid: vault, staleNames } = await auditVault();

    // RC1 HIGH: active 세션이 있는데 무결성 깨짐 = corrupt → 폐기 + 거부.
    if (at && activeRt && !activeId) {
      const corrupt = NextResponse.json(
        { error: { code: 'ACTIVE_SESSION_CORRUPT', message: 'active session integrity check failed' } },
        { status: 401 },
      );
      discardActiveSession(corrupt.cookies);
      discardCookies(corrupt.cookies, staleNames);
      return corrupt;
    }

    const tokens = [...(activeRt ? [activeRt] : []), ...vault.map((v) => v.refreshToken)];
    if (tokens.length === 0) return NextResponse.json({ data: { accounts: [] } });

    // BE 메타 resolve(서버 only·토큰 경계 밖 X). 404/실패 = graceful.
    const metaById = new Map<string, Partial<AccountMeta>>();
    try {
      const session = await getServerSession();
      const r = await fetch(`${FASTAPI_URL()}/api/v2/accounts/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ refresh_tokens: tokens }),
      });
      if (r.ok) {
        const j = (await r.json()) as { data?: { accounts?: AccountMeta[] }; accounts?: AccountMeta[] };
        for (const a of j.data?.accounts ?? j.accounts ?? []) metaById.set(a.account_id, a);
      }
    } catch {
      /* graceful — 아래 decode 최소 리스트 */
    }

    const seen = new Set<string>();
    const accounts: AccountMeta[] = [];
    const push = async (rt: string, isActive: boolean) => {
      const id = await decodeAccountId(rt, 'refresh');
      if (!id || seen.has(id)) return;
      seen.add(id);
      const m = metaById.get(id);
      accounts.push({
        account_id: id,
        name: m?.name ?? null,
        email: m?.email ?? null,
        org_name: m?.org_name ?? null,
        avatar_url: m?.avatar_url ?? null,
        status: isActive ? 'active' : (m?.status === 'expired' ? 'expired' : 'inactive'),
      });
    };
    if (activeRt) await push(activeRt, activeId != null);
    for (const v of vault) await push(v.refreshToken, false);

    const res = NextResponse.json({ data: { accounts } });
    discardCookies(res.cookies, staleNames); // RC1: stale vault 폐기
    return res;
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
