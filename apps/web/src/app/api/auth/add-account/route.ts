import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase } from '@/lib/auth/cookies';
import { handleApiError } from '@/lib/api-error';
import {
  ACTIVE_ACCOUNT_COOKIE,
  getVerifiedActiveAccountId,
  setVaultEntry,
} from '@/lib/auth/account-vault';

/**
 * POST /api/auth/add-account (ⓒ) — 계정 추가 진입.
 * 현 active 계정 RT를 vault에 보존하고 active 포인터를 비운 뒤 클라가 로그인 플로우로 진입한다.
 * 로그인 완료 시 새 계정이 active(sp_at/sp_rt)·이전 계정은 vault에 남아 switcher에 노출.
 * (active 포인터 제거 → 로그인 後 sp_at.sub 로 active 도출·stale 포인터 mismatch 방지.)
 */
export async function POST(request: Request) {
  try {
    const csrf = verifyCsrfOrigin(request);
    if (csrf) return csrf;

    const store = await cookies();
    const res = NextResponse.json({ data: { ok: true, redirect: '/login' } });

    const currentId = await getVerifiedActiveAccountId();
    const currentRt = store.get(SP_RT_COOKIE)?.value;
    if (currentId && currentRt) {
      setVaultEntry(res.cookies, currentId, currentRt);
      // active 포인터 제거 — 로그인 後 새 sp_at.sub 가 active(stale 포인터 mismatch 방지).
      res.cookies.set(ACTIVE_ACCOUNT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    }
    return res;
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
