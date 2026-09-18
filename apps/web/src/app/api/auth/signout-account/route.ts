import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase } from '@/lib/auth/cookies';
import { handleApiError } from '@/lib/api-error';
import {
  ACTIVE_ACCOUNT_COOKIE,
  CURRENT_PROJECT_COOKIE,
  auditVault,
  clearAllAccounts,
  discardCookies,
  getVerifiedActiveAccountId,
  removeVaultEntry,
} from '@/lib/auth/account-vault';
import { clearSuperseded, markSuperseded } from '@/lib/auth/switch-epoch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
const RT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * RC3: 단건 RT revoke만(bulk는 "전체"에서만). best-effort — PO 정책 決(2026-09-07,
 * story #3644): 로컬 사인아웃은 이 결과와 무관하게 항상 성공 처리한다(쿠키가 실제로
 * 지워지므로 정직). 사용자 문장은 불필요하나 침묵은 금지 — 구조화 로그 한 줄.
 *
 * ⚠️보안 표면: 이 revoke가 실패하면 refresh token이 자연 만료 前까지 서버측에
 * 유효한 채로 남는다. 이 로그는 그 잔존을 서버측에서 관측하기 위한 것 — user_id/
 * token 원문·해시는 절대 싣지 않는다(사유·상태만).
 */
async function beRevoke(refreshToken: string): Promise<void> {
  try {
    const res = await fetch(`${FASTAPI_URL()}/api/v2/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      console.warn('[signout-account] beRevoke non-ok — refresh token may remain valid until natural expiry', { status: res.status });
    }
  } catch (error) {
    console.warn('[signout-account] beRevoke threw — refresh token may remain valid until natural expiry', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/auth/signout-account { scope: 'this' | 'all' }
 * - this: 현 active 계정만 로그아웃 + 다음 vault 계정으로 전환(없으면 전체 클리어).
 * - all: active + 전 vault 클리어(bulk revoke·RC3는 bulk를 여기에 한정).
 */
export async function POST(request: Request) {
  try {
    const csrf = verifyCsrfOrigin(request);
    if (csrf) return csrf;

    const body = (await request.json().catch(() => null)) as { scope?: 'this' | 'all' } | null;
    const scope = body?.scope ?? 'this';
    const store = await cookies();
    const activeRt = store.get(SP_RT_COOKIE)?.value;

    if (scope === 'all') {
      // bulk revoke(RC3: sign-out 전체에서만) — active + vault 전건 best-effort.
      const { valid: vault } = await auditVault();
      const activeId = await getVerifiedActiveAccountId();
      // RC2 epoch: 전 계정 supersede — in-flight refresh 가 Set-Cookie 로 되살리지 못하게.
      if (activeId) markSuperseded(activeId);
      for (const v of vault) markSuperseded(v.accountId);
      await Promise.all([
        ...(activeRt ? [beRevoke(activeRt)] : []),
        ...vault.map((v) => beRevoke(v.refreshToken)),
      ]);
      const res = NextResponse.json({ data: { ok: true, next: null } });
      await clearAllAccounts(res.cookies);
      return res;
    }

    // scope === 'this' — 현 계정만 revoke, 다음 vault 계정 승격.
    // RC2: 떠난 계정 supersede 마킹을 외부 await(revoke) **前**으로 — late refresh 결정적 억제.
    const signedOutId = await getVerifiedActiveAccountId();
    if (signedOutId) markSuperseded(signedOutId);
    if (activeRt) await beRevoke(activeRt);
    const { valid: vault, staleNames } = await auditVault();
    const next = vault[0];
    const base = cookieBase();

    if (!next) {
      // 남은 계정 없음 → 전체 클리어(FE는 /login).
      const res = NextResponse.json({ data: { ok: true, next: null } });
      await clearAllAccounts(res.cookies);
      return res;
    }

    // 다음 계정 승격: sp_rt=next RT, sp_at 제거(middleware single-flight refresh가 fresh sp_at 발급),
    // active 포인터 갱신, current-project 리셋, next는 vault서 제거.
    const res = NextResponse.json({ data: { ok: true, next: next.accountId } });
    res.cookies.set(SP_AT_COOKIE, '', { ...base, maxAge: 0 });
    res.cookies.set(SP_RT_COOKIE, next.refreshToken, { ...base, maxAge: RT_MAX_AGE_SECONDS });
    res.cookies.set(ACTIVE_ACCOUNT_COOKIE, next.accountId, { ...base, maxAge: RT_MAX_AGE_SECONDS });
    res.cookies.set(CURRENT_PROJECT_COOKIE, '', { path: '/', sameSite: 'lax', maxAge: 0 });
    removeVaultEntry(res.cookies, next.accountId);
    clearSuperseded(next.accountId); // 승격된 next 는 active — epoch 마킹 해제(정상 refresh 허용)
    discardCookies(res.cookies, staleNames); // RC1: stale vault 폐기
    return res;
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
