'use client';

import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { OrgMembersSection } from '@/components/settings/org-members-section';

export default function OrganizationMembersPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';

  if (!orgId) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <OrgMembersSection orgId={orgId} currentRole={currentRole} />
    </div>
  );
}
