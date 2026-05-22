'use client';

import Link from 'next/link';
import { ChevronsUpDown, Settings, LogOut } from 'lucide-react';
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
  const displayLabel = email ?? name;

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
        <DropdownMenuItem>
          <Link href="/settings" className="flex w-full items-center gap-2">
            <Settings className="size-4" />
            설정
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* DS-S2에서 LogoutButton 통합 예정 */}
        <DropdownMenuItem disabled className="flex items-center gap-2 text-muted-foreground">
          <LogOut className="size-4" />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
