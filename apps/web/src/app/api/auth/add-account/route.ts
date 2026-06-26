import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase } from '@/lib/auth/cookies';
import { handleApiError } from '@/lib/api-error';
import { ACCOUNT_CAP } from '@/lib/auth/account-limits';
import {
  ACTIVE_ACCOUNT_COOKIE,
  auditVault,
  discardActiveSession,
  discardCookies,
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
    const at = store.get(SP_AT_COOKIE)?.value;
    const currentRt = store.get(SP_RT_COOKIE)?.value;
    const currentId = await getVerifiedActiveAccountId();
    const { valid: vault, staleNames } = await auditVault();

    // RC1: active 세션이 corrupt(sp_at.sub != sp_rt.sub / 포인터 mismatch)면 폐기 + 401 거부
    // (corrupt RT를 vault에 넣지 않음·PR1 accounts/switch 동일 배선).
    if (at && currentRt && !currentId) {
      const corrupt = NextResponse.json(
        { error: { code: 'ACTIVE_SESSION_CORRUPT', message: 'active session integrity check failed' } },
        { status: 401 },
      );
      discardActiveSession(corrupt.cookies);
      discardCookies(corrupt.cookies, staleNames);
      return corrupt;
    }

    // 5-cap server guard — UI 비활성만으로는 클라 우회 POST 가능. 서버서 한도 enforce.
    const total = vault.length + (currentId ? 1 : 0);
    if (total >= ACCOUNT_CAP) {
      const capped = NextResponse.json(
        { error: { code: 'ACCOUNT_LIMIT_REACHED', message: 'account limit reached' } },
        { status: 409 },
      );
      discardCookies(capped.cookies, staleNames);
      return capped;
    }

    const res = NextResponse.json({ data: { ok: true, redirect: '/login' } });
    if (currentId && currentRt) {
      setVaultEntry(res.cookies, currentId, currentRt);
      // active 포인터 제거 — 로그인 後 새 sp_at.sub 가 active(stale 포인터 mismatch 방지).
      res.cookies.set(ACTIVE_ACCOUNT_COOKIE, '', { ...cookieBase(), maxAge: 0 });
    }
    discardCookies(res.cookies, staleNames); // RC1: stale vault 폐기
    return res;
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
