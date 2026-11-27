'use client';

import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { OrgMembersTopBarTitle, TitleTopBarSlot, useOrgMembersTopBarTitleText } from '@/components/nav/flat-tab-top-bar';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OrgMembersSection } from '@/components/settings/org-members-section';

export default function OrganizationMembersPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';

  if (!orgId) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        <TitleTopBarSlot title={<OrgMembersTopBarTitle />} useText={useOrgMembersTopBarTitleText} showContextChip />
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <TitleTopBarSlot title={<OrgMembersTopBarTitle />} useText={useOrgMembersTopBarTitleText} showContextChip />
      <OrgMembersSection orgId={orgId} currentRole={currentRole} />
    </div>
  );
}
