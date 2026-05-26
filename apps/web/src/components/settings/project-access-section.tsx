'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';

interface OrgMember {
  id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

interface AccessRecord {
  id: string;
  org_member_id: string;
  project_id: string;
  permission: string;
}

interface ProjectAccessSectionProps {
  projectId: string;
  currentRole: string;
}

export function ProjectAccessSection({ projectId, currentRole }: ProjectAccessSectionProps) {
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [accessRecords, setAccessRecords] = useState<AccessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const canManage = currentRole === 'owner' || currentRole === 'admin';

  const refreshData = async () => {
    const [membersRes, accessRes] = await Promise.all([
      fetch('/api/org-members').catch(() => null),
      fetch(`/api/projects/${projectId}/access`).catch(() => null),
    ]);
    if (membersRes?.ok) {
      const json = await membersRes.json() as OrgMember[] | { data?: OrgMember[] };
      setOrgMembers(Array.isArray(json) ? json : (json.data ?? []));
    }
    if (accessRes?.ok) {
      const json = await accessRes.json() as AccessRecord[] | { data?: AccessRecord[] };
      setAccessRecords(Array.isArray(json) ? json : (json.data ?? []));
    }
    setLoading(false);
  };

  useEffect(() => {
    void refreshData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const isBlocked = (orgMemberId: string) =>
    accessRecords.some((r) => r.org_member_id === orgMemberId && r.permission === 'denied');

  const getRecord = (orgMemberId: string) =>
    accessRecords.find((r) => r.org_member_id === orgMemberId && r.permission === 'denied');

  const handleToggle = async (member: OrgMember) => {
    if (!canManage || toggling) return;
    setToggling(member.id);
    setMessage(null);
    try {
      if (isBlocked(member.id)) {
        const record = getRecord(member.id);
        if (!record) return;
        const res = await fetch(`/api/projects/${projectId}/access/${record.id}`, { method: 'DELETE' });
        if (res.ok) {
          setMessage({ type: 'success', text: '접근 허용으로 변경됐습니다.' });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: '변경에 실패했습니다.' });
        }
      } else {
        const res = await fetch(`/api/projects/${projectId}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_member_id: member.id, permission: 'denied' }),
        });
        if (res.ok) {
          setMessage({ type: 'success', text: '접근이 차단됐습니다.' });
          await refreshData();
        } else {
          setMessage({ type: 'error', text: '변경에 실패했습니다.' });
        }
      }
    } finally {
      setToggling(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />)}
      </div>
    );
  }

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">프로젝트 접근 권한</h2>
          <p className="text-sm text-muted-foreground">
            조직 멤버별 이 프로젝트 접근 권한을 관리합니다. 차단된 멤버는 이 프로젝트를 볼 수 없습니다.
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {message && (
          <Alert variant={message.type === 'success' ? 'success' : 'destructive'}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        {orgMembers.length === 0 ? (
          <p className="text-sm text-muted-foreground">조직 멤버가 없습니다.</p>
        ) : (
          orgMembers.map((member) => {
            const blocked = isBlocked(member.id);
            const isOwner = member.role === 'owner';
            return (
              <div key={member.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-muted-foreground truncate">{member.user_id}</div>
                  <Badge variant={isOwner ? 'info' : 'secondary'} className="capitalize mt-0.5">{member.role}</Badge>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {blocked ? (
                    <Badge variant="destructive" className="text-[10px]">차단됨</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">허용</Badge>
                  )}
                  {canManage && !isOwner && (
                    <button
                      type="button"
                      disabled={toggling === member.id}
                      onClick={() => void handleToggle(member)}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${blocked ? 'bg-success-tint text-success hover:bg-success/20' : 'bg-destructive/10 text-destructive hover:bg-destructive/20'} disabled:opacity-50`}
                    >
                      {toggling === member.id ? '...' : blocked ? '허용' : '차단'}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
