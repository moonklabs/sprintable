'use client';

import { useState } from 'react';
import { Check, ChevronDown, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';

export interface OrgSwitcherItem {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role?: string;
}

function OrgInitial({ name }: { name: string }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-brand text-[10px] font-semibold text-brand-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

interface OrganizationSwitcherProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  className?: string;
}

export function OrganizationSwitcher({ orgs, currentOrgId, className }: OrganizationSwitcherProps) {
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const currentOrg = orgs.find((o) => o.orgId === currentOrgId);
  const displayName = currentOrg?.orgName ?? 'Organization';

  async function switchOrg(nextOrgId: string) {
    if (!nextOrgId || nextOrgId === currentOrgId || pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      if (res.ok) {
        window.location.href = '/dashboard';
      }
    } finally {
      setPending(false);
    }
  }

  function handleCreated(orgId: string) {
    window.location.href = `/onboarding?step=project&orgId=${orgId}`;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={pending}
          render={
            <SidebarMenuButton className={cn('w-full', className)}>
              <OrgInitial name={displayName} />
              <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
                {displayName}
              </span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent className="w-auto min-w-56" align="start" side="bottom" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Organizations
            </DropdownMenuLabel>
            {orgs.map((org) => (
              <DropdownMenuItem
                key={org.orgId}
                disabled={pending}
                onClick={() => void switchOrg(org.orgId)}
              >
                <OrgInitial name={org.orgName} />
                <div className="flex flex-1 flex-col truncate">
                  <span className="truncate">{org.orgName}</span>
                  {org.role && (
                    <span className="text-[10px] text-muted-foreground capitalize">{org.role}</span>
                  )}
                </div>
                {org.orgId === currentOrgId && (
                  <Check className="h-3.5 w-3.5 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => { window.location.href = '/settings?tab=organization'; }}>
            <Settings className="h-3.5 w-3.5" />
            <span>Organization 설정</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            <span>새 Organization 만들기</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrganizationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />
    </>
  );
}
