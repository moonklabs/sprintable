'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ChevronsUpDown, Settings, LogOut, Plus, Check, Loader2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ACCOUNT_CAP } from '@/lib/auth/account-limits';

interface Account {
  account_id: string;
  name: string | null;
  email: string | null;
  org_name: string | null;
  avatar_url: string | null;
  status: 'active' | 'inactive' | 'expired';
}

interface ProfileMenuProps {
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
}

function initialOf(label: string | null | undefined): string {
  const s = (label ?? '').trim();
  return s ? s[0]!.toUpperCase() : '?';
}

function Avatar({ url, label, className }: { url?: string | null; label: string; className?: string }) {
  if (url) {
    return (
      <Image
        src={url}
        alt=""
        width={28}
        height={28}
        unoptimized
        className={cn('shrink-0 rounded-md object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground',
        className,
      )}
    >
      {initialOf(label)}
    </span>
  );
}

export function ProfileMenu({ name, avatarUrl }: ProfileMenuProps) {
  const router = useRouter();
  const t = useTranslations('accountSwitcher');
  const tc = useTranslations('common');
  const tn = useTranslations('nav');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // account_id | 'add' | 'signout'
  const [error, setError] = useState<string | null>(null);

  // 드롭다운 열 때 fetch(이벤트 기반 — effect 내 setState 회피·불필요한 상시 호출 방지).
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/accounts');
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

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-sidebar-accent">
        <Avatar url={triggerAvatar} label={triggerName} className="size-7" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">{triggerName}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('title')}</DropdownMenuLabel>
        <DropdownMenuGroup>
          {ordered.map((acc) => {
            const isActive = acc.status === 'active';
            const isExpired = acc.status === 'expired';
            const label = acc.name ?? acc.email ?? tc('unknown');
            return (
              <DropdownMenuItem
                key={acc.account_id}
                disabled={busy !== null || isActive}
                onClick={() => void handleSwitch(acc)}
                className={cn('flex items-center gap-2', isActive && 'bg-info/10')}
              >
                <Avatar url={acc.avatar_url} label={label} className="size-6" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{label}</span>
                  {isExpired ? (
                    <span className="truncate text-xs text-muted-foreground">{t('reloginRequired')}</span>
                  ) : (
                    acc.email && acc.email !== label && (
                      <span className="truncate text-xs text-muted-foreground">{acc.email}</span>
                    )
                  )}
                </span>
                {isActive && <Check className="size-4 shrink-0 text-info" />}
                {busy === acc.account_id && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={atCap || busy !== null}
          onClick={() => void handleAdd()}
          className="flex items-center gap-2"
        >
          {busy === 'add' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          <span className="flex-1">{t('addAccount')}</span>
          {atCap && <span className="text-xs text-muted-foreground">{t('capReached')}</span>}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings" />}>
          <Settings className="size-4" />
          {tn('settings')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy !== null}
          onClick={() => void handleSignOut('this')}
          className="flex items-center gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <LogOut className="size-4" />
          {others.length > 0 ? t('signOutThis') : tc('logout')}
        </DropdownMenuItem>
        {others.length > 0 && (
          <DropdownMenuItem
            disabled={busy !== null}
            onClick={() => void handleSignOut('all')}
            className="flex items-center gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <LogOut className="size-4" />
            {t('signOutAll')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
