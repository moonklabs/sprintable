'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ACCOUNT_CAP } from '@/lib/auth/account-limits';
import { fetchWithAuth } from '@/lib/db/client';

export interface Account {
  account_id: string;
  name: string | null;
  email: string | null;
  org_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'expired';
}

/**
 * story #3146/#3147(doc mobile-switcher-redesign-spec-4758744a §③ 계정층) — 원래
 * profile-menu.tsx(데스크톱 AppSidebar 전용 DropdownMenu) 안에만 있던 계정 목록·전환·
 * 추가·로그아웃 상태·핸들러를 그대로 추출했다(재구현 0 — 로직 한 글자도 안 바꿈). 두 표현
 * (데스크톱 DropdownMenu·모바일 바텀시트 계정층)이 이 훅 하나를 공유해 API 호출·에러
 * 처리·optimistic 규율이 항상 같다. `name`은 계정 목록 fetch 전 낙관적 표시용 폴백
 * (profile-menu.tsx의 기존 prop 그대로).
 */
export function useAccountSwitcher(name: string, avatarUrl?: string | null) {
  const router = useRouter();
  const t = useTranslations('accountSwitcher');
  const tc = useTranslations('common');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // account_id | 'add' | 'signout'
  const [error, setError] = useState<string | null>(null);

  // 열 때 fetch(이벤트 기반 — effect 내 setState 회피·불필요한 상시 호출 방지). 호출부가
  // (드롭다운 open·시트 open) 각자의 열림 이벤트에서 부른다.
  const load = useCallback(async () => {
    try {
      const r = await fetchWithAuth('/api/accounts');
      if (!r.ok) return;
      const j = (await r.json()) as { data?: { accounts?: Account[] }; accounts?: Account[] };
      setAccounts(j.data?.accounts ?? j.accounts ?? []);
    } catch {
      /* prop fallback 유지 */
    }
  }, []);

  const active = accounts.find((a) => a.status === 'active');
  const others = accounts.filter((a) => a.status !== 'active');
  const ordered = active ? [active, ...others] : others;
  const triggerName = active?.name ?? active?.email ?? name;
  const triggerAvatar = active?.avatar_url ?? avatarUrl ?? null;
  const atCap = accounts.length >= ACCOUNT_CAP;

  // switch/add/signout-account는 의도적으로 raw fetch 유지(fetchWithAuth 미적용) — 세션
  // 정체성 자체를 바꾸는 경로라 401을 fetchWithAuth의 전역 refresh-then-retry로 흡수하면
  // 방금 전환/추가/로그아웃하려던 계정이 아닌 갱신된 舊세션으로 재시도되는 경쟁이 생긴다(예:
  // add-account가 이미 자체 401 처리로 즉시 /login 바운스하는 것도 이 때문 — 원본 profile-
  // menu.tsx부터 있던 동작, 재구현 0). GRANDFATHER_BASELINE 등재(PO 페드루, PR#3558).
  const handleSwitch = async (acc: Account) => {
    if (busy || acc.status === 'active') return;
    if (acc.status === 'expired') {
      window.location.assign('/login'); // 만료 = switch 불가 → 로그인 재진입
      return;
    }
    setBusy(acc.account_id);
    setError(null);
    try {
      const r = await fetch('/api/auth/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: acc.account_id }),
      });
      if (!r.ok) {
        // 409(전환 중/실패) 포함 graceful — 낙관 전환 안 함·spinner 복구.
        setError(t('switchFailed'));
        setBusy(null);
        return;
      }
      window.location.assign('/inbox'); // active 전환 → 풀 리로드로 전 컨텍스트 리셋
    } catch {
      setError(t('switchFailed'));
      setBusy(null);
    }
  };

  const handleAdd = async () => {
    if (atCap || busy) return;
    setBusy('add');
    setError(null);
    try {
      const r = await fetch('/api/auth/add-account', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) {
        if (r.status === 401) {
          window.location.assign('/login'); // corrupt active → 폐기됨·로그인 재진입
          return;
        }
        setError(t('capReached')); // 409 cap(서버 guard·UI 우회 방어) 등
        setBusy(null);
        return;
      }
      const j = (await r.json().catch(() => null)) as { data?: { redirect?: string } } | null;
      window.location.assign(j?.data?.redirect ?? '/login');
    } catch {
      setBusy(null);
    }
  };

  const handleSignOut = async (scope: 'this' | 'all') => {
    if (busy) return;
    setBusy('signout');
    try {
      const r = await fetch('/api/auth/signout-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const j = (await r.json().catch(() => null)) as { data?: { next?: string | null } } | null;
      window.location.assign(scope === 'this' && j?.data?.next ? '/inbox' : '/login');
    } catch {
      router.push('/login');
    }
  };

  return {
    t, tc,
    accounts, ordered, others, active,
    busy, error, atCap,
    triggerName, triggerAvatar,
    load, handleSwitch, handleAdd, handleSignOut,
  };
}
