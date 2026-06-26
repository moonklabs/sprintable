import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import {
  VAULT_PREFIX,
  auditVault,
  decodeAccountId,
  discardActiveSession,
  discardCookies,
  getVerifiedActiveAccountId,
  rtHash,
  setActiveAccount,
  setVaultEntry,
  removeVaultEntry,
} from '@/lib/auth/account-vault';
import { clearSuperseded, markSuperseded } from '@/lib/auth/switch-epoch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

interface SwitchResult {
  access_token: string;
  refresh_token: string;
  project_id: string | null;
}

// RC2: per-account single-flight — 키 `${targetAccountId}:${targetRtHash}`(RT 원문 미사용).
// 동시 2탭 동일 target switch = 1 rotation 공유(single-use RT 이중소비 방지). 실패/미준비 = 409.
type Entry = { p: Promise<SwitchResult | null>; settledAt: number | null };
const inflight = new Map<string, Entry>();
const GRACE_MS = 5_000;

async function rotate(targetRt: string): Promise<SwitchResult | null> {
  try {
    const r = await fetch(`${FASTAPI_URL()}/api/v2/auth/switch-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: targetRt }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: Partial<SwitchResult>; access_token?: string; refresh_token?: string; project_id?: string | null };
    const d = j.data ?? j;
    if (!d.access_token || !d.refresh_token) return null;
    return { access_token: d.access_token, refresh_token: d.refresh_token, project_id: d.project_id ?? null };
  } catch {
    return null;
  }
}

function singleFlightRotate(targetId: string, targetRt: string): Promise<SwitchResult | null> {
  const key = `${targetId}:${rtHash(targetRt)}`;
  const now = Date.now();
  const ex = inflight.get(key);
  if (ex && (ex.settledAt === null || ex.settledAt + GRACE_MS > now)) return ex.p;
  const entry: Entry = { p: rotate(targetRt), settledAt: null };
  inflight.set(key, entry);
  void entry.p.finally(() => { entry.settledAt = Date.now(); });
  if (inflight.size > 64) {
    for (const [k, v] of inflight) if (v.settledAt !== null && v.settledAt + GRACE_MS <= now) inflight.delete(k);
  }
  return entry.p;
}

/** POST /api/auth/switch-account { account_id } — vault target으로 active 전환(원자적·RC1/2/3). */
export async function POST(request: Request) {
  try {
    const csrf = verifyCsrfOrigin(request);
    if (csrf) return csrf;

    const body = (await request.json().catch(() => null)) as { account_id?: string } | null;
    const targetId = body?.account_id;
    if (!targetId) return ApiErrors.badRequest('account_id required');

    const store = await cookies();

    // RC1: 현 active 세션이 corrupt(sp_at.sub != sp_rt.sub / 포인터 mismatch)면 폐기 + 거부.
    const at = store.get(SP_AT_COOKIE)?.value;
    const rt = store.get(SP_RT_COOKIE)?.value;
    const prevActiveId = await getVerifiedActiveAccountId();
    if (at && rt && !prevActiveId) {
      const corrupt = NextResponse.json(
        { error: { code: 'ACTIVE_SESSION_CORRUPT', message: 'active session integrity check failed' } },
        { status: 401 },
      );
      discardActiveSession(corrupt.cookies);
      const audit = await auditVault();
      discardCookies(corrupt.cookies, audit.staleNames);
      return corrupt;
    }

    // RC1: vault 쿠키 존재 + suffix == decoded RT sub 검증(아니면 폐기·거부).
    const targetRt = store.get(`${VAULT_PREFIX}${targetId}`)?.value;
    if (!targetRt) return ApiErrors.badRequest('account not in vault');
    const decoded = await decodeAccountId(targetRt, 'refresh'); // RC1 MED: type=refresh
    if (decoded !== targetId) {
      const bad = NextResponse.json({ error: { code: 'ACCOUNT_BINDING_MISMATCH', message: 'vault binding invalid' } }, { status: 400 });
      removeVaultEntry(bad.cookies, targetId); // RC1 폐기
      return bad;
    }

    const result = await singleFlightRotate(targetId, targetRt);
    if (!result) {
      // BE 미머지/회전 실패/동시 충돌 → 409 graceful(유나 UX switch-error 분기).
      return NextResponse.json({ error: { code: 'SWITCH_UNAVAILABLE', message: 'switch failed or in progress' } }, { status: 409 });
    }

    // 원자적 swap(한 Set-Cookie 응답·switch-org 선례): 현 active RT → vault 보존, target → active, target vault 제거.
    const res = NextResponse.json({ data: { ok: true, account_id: targetId, project_id: result.project_id } });
    if (prevActiveId && rt && prevActiveId !== targetId) setVaultEntry(res.cookies, prevActiveId, rt);
    setActiveAccount(res.cookies, targetId, result.access_token, result.refresh_token, result.project_id);
    removeVaultEntry(res.cookies, targetId);
    // RC2 epoch: target 재활성=마킹 해제(switch-back 보존·RC3) / 떠난 계정=마킹(stale refresh 억제).
    clearSuperseded(targetId);
    if (prevActiveId && prevActiveId !== targetId) markSuperseded(prevActiveId);
    // RC1 enforcement: 잔여 stale vault 쿠키(suffix/type 위반) 폐기.
    const { staleNames } = await auditVault();
    discardCookies(res.cookies, staleNames.filter((n) => n !== `${VAULT_PREFIX}${targetId}`));
    return res;
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
