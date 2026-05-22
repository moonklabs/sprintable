'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronsUpDown, Settings, LogOut } from 'lucide-react';
import { logoutUser } from '@/lib/db/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ProfileMenuProps {
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
}

function getInitial(name: string): string {
  if (!name) return '?';
  return name[0]?.toUpperCase() ?? '?';
}

export function ProfileMenu({ name, email }: ProfileMenuProps) {
  const router = useRouter();
  const t = useTranslations('common');
  const displayLabel = email ?? name;

  const handleLogout = async () => {
    await logoutUser();
    router.push('/login');
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-sidebar-accent">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
          {getInitial(name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
          {name}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{name}</span>
          {displayLabel !== name && (
            <span className="text-xs font-normal text-muted-foreground">{displayLabel}</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings" />}>
          <Settings className="size-4" />
          설정
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void handleLogout()} className="flex items-center gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive">
          <LogOut className="size-4" />
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
