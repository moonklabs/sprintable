/**
 * 멀티계정 스위칭 — account-scoped credential vault (bf305fa0).
 * 설계: active 계정은 sp_at/sp_rt 그대로(앱 전체 무변경) · inactive 계정 refresh token만 vault 쿠키에.
 * 보안(산티아고 RC·doc §4.1):
 *  - RC1: `sp_acct_rt_<id>` 쿠키 suffix는 신뢰 안 함. accountId SSOT = decoded RT `sub`.
 *         vault suffix == decoded RT sub 검증 / active == sp_at.sub == sp_rt.sub 검증 · mismatch=폐기.
 *  - RC3: switch는 target RT만 회전 · inactive vault 보존 · bulk 제거는 sign-out("전체")만.
 *  - 횡단: RT 원문 로그 금지(hash만) · vault 삭제 = prefix enumerate → maxAge:0.
 * accountId default = RT `sub`(현 JWT payload·BE 무변경). BE가 account_id claim 추가 택 시 decodeAccountId만 교체.
 */
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from './cookies';

export const VAULT_PREFIX = 'sp_acct_rt_';
export const ACTIVE_ACCOUNT_COOKIE = 'sp_active_account';
export const CURRENT_PROJECT_COOKIE = 'sprintable_current_project_id';
const RT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type CookieSetter = {
  set: (name: string, value: string, opts: Record<string, unknown>) => void;
};

function jwtSecretBytes(): Uint8Array {
  return new TextEncoder().encode(process.env['JWT_SECRET'] ?? '');
}

/** RT 원문 로그 금지 — single-flight 키/로깅용 단방향 해시(앞 12자). */
export function rtHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * JWT 서명 검증 + (RC1 MED) type claim 검증 + sub 추출. accountId SSOT 진입점.
 * expectedType: vault/sp_rt='refresh', sp_at='access' — access 토큰을 vault에 끼우는 혼용 차단.
 * 실패(서명/type/sub)=null.
 */
export async function decodeAccountId(token: string, expectedType?: 'access' | 'refresh'): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecretBytes());
    if (expectedType && payload['type'] !== expectedType) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** 쿠키 전건 maxAge:0 폐기(RC1 enforcement·stale vault cleanup). */
export function discardCookies(res: CookieSetter, names: string[]): void {
  const base = cookieBase();
  for (const name of names) res.set(name, '', { ...base, maxAge: 0 });
}

export interface VaultEntry {
  accountId: string;
  refreshToken: string;
}

export interface VaultAudit {
  valid: VaultEntry[];
  /** RC1 위반(suffix != decoded sub·type != refresh·서명불일치) vault 쿠키 이름 — 호출측이 maxAge:0 폐기. */
  staleNames: string[];
}

/**
 * vault 쿠키 전건 audit — RC1(suffix == decoded RT sub) + RC1 MED(type=='refresh') 통과만 valid,
 * 위반은 staleNames(폐기 대상). 호출측이 discardCookies(res.cookies, staleNames)로 enforcement.
 */
export async function auditVault(): Promise<VaultAudit> {
  const store = await cookies();
  const valid: VaultEntry[] = [];
  const staleNames: string[] = [];
  for (const c of store.getAll()) {
    if (!c.name.startsWith(VAULT_PREFIX)) continue;
    const suffix = c.name.slice(VAULT_PREFIX.length);
    const sub = await decodeAccountId(c.value, 'refresh');
    if (sub && sub === suffix) valid.push({ accountId: sub, refreshToken: c.value });
    else staleNames.push(c.name); // RC1 위반 → 폐기
  }
  return { valid, staleNames };
}

/**
 * RC1: active 무결성 — sp_at(type=access).sub == sp_rt(type=refresh).sub == sp_active_account.
 * 일치 시 accountId, 아니면 null(호출측은 corrupt active 폐기+거부).
 */
export async function getVerifiedActiveAccountId(): Promise<string | null> {
  const store = await cookies();
  const at = store.get(SP_AT_COOKIE)?.value;
  const rt = store.get(SP_RT_COOKIE)?.value;
  if (!at || !rt) return null;
  const atSub = await decodeAccountId(at, 'access');
  const rtSub = await decodeAccountId(rt, 'refresh');
  if (!atSub || atSub !== rtSub) return null;
  const pointer = store.get(ACTIVE_ACCOUNT_COOKIE)?.value;
  if (pointer && pointer !== atSub) return null; // 포인터 mismatch = corrupt
  return atSub;
}

/** active 세션(sp_at/sp_rt/포인터) 폐기 — corrupt active mismatch enforcement(RC1 HIGH). */
export function discardActiveSession(res: CookieSetter): void {
  const base = cookieBase();
  res.set(SP_AT_COOKIE, '', { ...base, maxAge: 0 });
  res.set(SP_RT_COOKIE, '', { ...base, maxAge: 0 });
  res.set(ACTIVE_ACCOUNT_COOKIE, '', { ...base, maxAge: 0 });
}

/** active 세션 + 포인터 set(+ project-context 리셋). switch-org 선례 동형. */
export function setActiveAccount(
  res: CookieSetter,
  accountId: string,
  accessToken: string,
  refreshToken: string,
  projectId: string | null | undefined,
): void {
  const base = cookieBase();
  res.set(SP_AT_COOKIE, accessToken, { ...base, maxAge: SP_AT_MAX_AGE_SECONDS });
  res.set(SP_RT_COOKIE, refreshToken, { ...base, maxAge: RT_MAX_AGE_SECONDS });
  res.set(ACTIVE_ACCOUNT_COOKIE, accountId, { ...base, maxAge: RT_MAX_AGE_SECONDS });
  // 전환 시 current-project는 항상 갱신(stale org/project leak 방지·switch-org 0746 선례).
  res.set(CURRENT_PROJECT_COOKIE, projectId ?? '', {
    path: '/', sameSite: 'lax', maxAge: projectId ? 60 * 60 * 24 * 365 : 0,
  });
}

/** vault에 inactive 계정 RT 보존(switch away 시). */
export function setVaultEntry(res: CookieSetter, accountId: string, refreshToken: string): void {
  res.set(`${VAULT_PREFIX}${accountId}`, refreshToken, { ...cookieBase(), maxAge: RT_MAX_AGE_SECONDS });
}

/** vault 단건 제거(switch in 後 target은 active로 승격되니 vault서 제거 / RC1 mismatch 폐기). */
export function removeVaultEntry(res: CookieSetter, accountId: string): void {
  res.set(`${VAULT_PREFIX}${accountId}`, '', { ...cookieBase(), maxAge: 0 });
}

/** sign-out "전체" — active + 전 vault + 포인터 클리어(prefix enumerate). */
export async function clearAllAccounts(res: CookieSetter): Promise<void> {
  const store = await cookies();
  const base = cookieBase();
  res.set(SP_AT_COOKIE, '', { ...base, maxAge: 0 });
  res.set(SP_RT_COOKIE, '', { ...base, maxAge: 0 });
  res.set(ACTIVE_ACCOUNT_COOKIE, '', { ...base, maxAge: 0 });
  res.set(CURRENT_PROJECT_COOKIE, '', { path: '/', sameSite: 'lax', maxAge: 0 });
  for (const c of store.getAll()) {
    if (c.name.startsWith(VAULT_PREFIX)) res.set(c.name, '', { ...base, maxAge: 0 });
  }
}
