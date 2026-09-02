'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
import { useAccountSwitcher } from '@/hooks/use-account-switcher';

interface ProfileMenuProps {
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  /** story #3146(모바일 계정 스위치) — 기본 트리거는 `sidebar-*` 테마 토큰을 쓴다(데스크톱
   * AppSidebar의 어두운 사이드바 배경 전제). 사이드바 밖(밝은 배경)에 그대로 꽂으면 글자색이
   * 배경과 거의 안 갈려 사실상 안 보인다 — 그 표면에서만 무채 배경용 클래스로 갈아끼운다
   * (기본값 생략 시 기존 desktop 클래스 그대로, 회귀 0). */
  triggerClassName?: string;
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

export function ProfileMenu({ name, avatarUrl, triggerClassName }: ProfileMenuProps) {
  const tn = useTranslations('nav');
  const {
    t, tc, ordered, others, busy, error, atCap,
    triggerName, triggerAvatar, load, handleSwitch, handleAdd, handleSignOut,
  } = useAccountSwitcher(name, avatarUrl);

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
      <DropdownMenuTrigger className={triggerClassName ?? 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-sidebar-accent'}>
        <Avatar url={triggerAvatar} label={triggerName} className="size-7" />
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', triggerClassName ? 'text-foreground' : 'text-sidebar-foreground')}>{triggerName}</span>
        <ChevronsUpDown className={cn('size-3.5 shrink-0', triggerClassName ? 'text-muted-foreground' : 'text-sidebar-foreground/60')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuGroup>
          {/* GroupLabel(base-ui)은 반드시 Group 내부 — Popup 직속이면 error #31 크래시. */}
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('title')}</DropdownMenuLabel>
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
        {/* story #2105 2차 — handleSwitch/handleAdd이 재시도 전 setError(null)을 먼저 호출해(위
            정의) 매 시도마다 언마운트→리마운트된다. */}
        {error && <p role="alert" aria-live="assertive" aria-atomic="true" className="px-2 py-1 text-xs text-destructive">{error}</p>}
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
          className="flex items-center gap-2 text-destructive focus:bg-destructive-tint focus:text-destructive"
        >
          <LogOut className="size-4" />
          {others.length > 0 ? t('signOutThis') : tc('logout')}
        </DropdownMenuItem>
        {others.length > 0 && (
          <DropdownMenuItem
            disabled={busy !== null}
            onClick={() => void handleSignOut('all')}
            className="flex items-center gap-2 text-destructive focus:bg-destructive-tint focus:text-destructive"
          >
            <LogOut className="size-4" />
            {t('signOutAll')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
