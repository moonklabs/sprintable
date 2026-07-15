'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HeartHandshake } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { MemberRow } from '@/components/ui/member-row';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import {
  groupRosterByRole,
  mergeMemberLookup,
  HistoryDrilldown,
  TrustBadge,
  type OrgSummaryRow,
  type RosterMember,
  type SelfScore,
} from './trust-utils';

export default function OrganizationTrustPage() {
  const { orgId, orgMemberships, currentTeamMemberId, projectId } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('organization');

  const [loading, setLoading] = useState(true);
  const [rosterRows, setRosterRows] = useState<OrgSummaryRow[]>([]);
  const [rosterMembers, setRosterMembers] = useState<Map<string, RosterMember>>(new Map());
  const [selfScores, setSelfScores] = useState<SelfScore[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function loadAdmin() {
      const [summaryRes, orgMembersRes, teamMembersRes] = await Promise.all([
        fetch('/api/trust-scores/org-summary').catch(() => null),
        fetch('/api/org-members').catch(() => null),
        projectId ? fetch(`/api/team-members?project_id=${projectId}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const summaryJson = summaryRes?.ok ? await summaryRes.json() as { members?: OrgSummaryRow[] } : { members: [] };
      const orgMembersJson = orgMembersRes?.ok ? await orgMembersRes.json() as { data?: Array<{ id: string; name?: string | null; email?: string | null }> } : { data: [] };
      const teamMembersJson = teamMembersRes?.ok ? await teamMembersRes.json() as { data?: Array<{ id: string; name?: string | null }> } : { data: [] };
      if (cancelled) return;
      setRosterRows(summaryJson.members ?? []);
      setRosterMembers(mergeMemberLookup(orgMembersJson.data ?? [], teamMembersJson.data ?? []));
      setLoading(false);
    }
    async function loadSelf() {
      if (!currentTeamMemberId) { setLoading(false); return; }
      const res = await fetch(`/api/trust-scores?member_id=${currentTeamMemberId}`).catch(() => null);
      if (cancelled) return;
      if (res?.ok) {
        const json = await res.json() as { scores?: SelfScore[] };
        setSelfScores(json.scores ?? []);
      }
      setLoading(false);
    }
    void (isAdmin ? loadAdmin() : loadSelf());
    return () => { cancelled = true; };
  }, [isAdmin, currentTeamMemberId, projectId]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-6">
        {[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  const groupedRoster = groupRosterByRole(rosterRows);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('trustSlotTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('trustPurposeFraming')}</p>
      </div>

      {isAdmin ? (
        groupedRoster.length === 0 ? (
          <EmptyState
            icon={<HeartHandshake className="size-8" />}
            title={t('trustSlotTitle')}
            description={t('trustEmptyRoster')}
          />
        ) : (
          groupedRoster.map(([groupLabel, rows]) => (
            <SectionCard key={groupLabel}>
              <SectionCardHeader>
                <h2 className="text-base font-semibold text-foreground">
                  {groupLabel} ({rows.length})
                </h2>
              </SectionCardHeader>
              <SectionCardBody>
                <div className="space-y-2">
                  {rows.map((row) => {
                    const member = rosterMembers.get(row.member_id);
                    return (
                      <MemberRow
                        key={`${row.member_id}-${row.role_key}`}
                        name={member?.name ?? t('trustUnknownMember')}
                        email={member?.email}
                        meta={<HistoryDrilldown memberId={row.member_id} roleKey={row.role_key} t={t} />}
                        actions={<TrustBadge hitRate={row.hit_rate} resolved={row.resolved} t={t} />}
                      />
                    );
                  })}
                </div>
              </SectionCardBody>
            </SectionCard>
          ))
        )
      ) : selfScores.length === 0 ? (
        <EmptyState
          icon={<HeartHandshake className="size-8" />}
          title={t('trustSlotTitle')}
          description={t('trustEmptySelf')}
        />
      ) : (
        <SectionCard>
          <SectionCardHeader>
            <h2 className="text-base font-semibold text-foreground">{t('trustSelfTitle')}</h2>
          </SectionCardHeader>
          <SectionCardBody>
            <div className="space-y-2">
              {selfScores.map((score) => (
                <MemberRow
                  key={score.role_key}
                  name={score.role_label ?? score.role_key}
                  meta={currentTeamMemberId ? <HistoryDrilldown memberId={currentTeamMemberId} roleKey={score.role_key} t={t} /> : undefined}
                  actions={<TrustBadge hitRate={score.hit_rate} resolved={score.resolved} t={t} />}
                />
              ))}
            </div>
          </SectionCardBody>
        </SectionCard>
      )}
    </div>
  );
}
