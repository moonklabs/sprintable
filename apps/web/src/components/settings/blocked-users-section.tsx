'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';

import { fetchWithAuth } from '@/lib/db/client';

interface UserBlockRow {
  blocked_member_id: string;
  created_at: string;
}

// story #2349 — 「차단한 사용자 목록」. 0명이면 절 자체를 안 그린다(PO 규격, standup-history-
// section.tsx의 return-null-on-empty 선례 재사용 — 새 패턴 발명 금지).
export function BlockedUsersSection() {
  const t = useTranslations('settings');
  const { addToast } = useToast();
  const [rows, setRows] = useState<UserBlockRow[]>([]);
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchBlocks = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/user-blocks', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json() as { data?: UserBlockRow[] };
      const list = json.data ?? [];
      setRows(list);
      const missing = list.map((r) => r.blocked_member_id).filter((id) => !(id in nameById));
      if (missing.length > 0) {
        const entries = await Promise.all(missing.map(async (id) => {
          try {
            const r = await fetchWithAuth(`/api/team-members/${id}`);
            if (!r.ok) return [id, id] as const;
            const j = await r.json() as { data?: { name?: string } };
            return [id, j.data?.name ?? id] as const;
          } catch {
            return [id, id] as const;
          }
        }));
        setNameById((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchBlocks(); }, [fetchBlocks]);

  const handleUnblock = useCallback(async (memberId: string) => {
    setBusyId(memberId);
    try {
      const res = await fetch(`/api/user-blocks/${memberId}`, { method: 'DELETE' });
      if (!res.ok) {
        addToast({ type: 'error', title: t('unblockUserErrorTitle') });
        return;
      }
      setRows((prev) => prev.filter((r) => r.blocked_member_id !== memberId));
    } finally {
      setBusyId(null);
    }
  }, [addToast, t]);

  if (loading || rows.length === 0) return null;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('blockedUsersTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('blockedUsersSubtitle')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.blocked_member_id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <span className="flex items-center gap-2 text-sm text-foreground">
              <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />
              {nameById[row.blocked_member_id] ?? row.blocked_member_id}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleUnblock(row.blocked_member_id)}
              disabled={busyId === row.blocked_member_id}
            >
              {busyId === row.blocked_member_id ? '...' : t('unblockUserAction')}
            </Button>
          </div>
        ))}
      </SectionCardBody>
    </SectionCard>
  );
}
