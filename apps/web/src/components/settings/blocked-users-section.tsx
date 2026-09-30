'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';

import { fetchWithAuth } from '@/lib/db/client';
import { disambiguateFallbackLabels, memberNameById } from '@/lib/member-display';

interface UserBlockRow {
  blocked_member_id: string;
  created_at: string;
  // story #4444 — the list's own name for the person (this org only · null when none); absent from an older server
  blocked_member_name?: string | null;
}

// story #2349 — 「차단한 사용자 목록」. 0명이면 절 자체를 안 그린다(PO 규격, standup-history-
// section.tsx의 return-null-on-empty 선례 재사용 — 새 패턴 발명 금지).
export function BlockedUsersSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { addToast } = useToast();
  const [rows, setRows] = useState<UserBlockRow[]>([]);
  // [SID:4286 · 까디르 873bcf080] 값 = 구성원 행(이름은 null일 수 있음) · 조회 실패는 표에 안 넣는다(→ «알 수 없는 구성원»). 예전엔 이름 빔 · 실패 둘 다
  // id를 이름 자리에 넣어 원시 UUID가 보였다.
  const [memberMap, setMemberMap] = useState<Record<string, { name: string | null }>>({});
  const [loading, setLoading] = useState(true);
  // story #4444 — a failed read is said as such (it used to render nothing, which looks like «no one blocked»)
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchBlocks = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetchWithAuth('/api/user-blocks', { cache: 'no-store' });
      if (!res.ok) { setLoadFailed(true); return; }
      // story #4444 — the backend answers a bare array (`response_model=list`, passed through by the proxy); reading
      // `json.data` only left the list always empty, so the section never showed. Only the contract's shape is read: any
      // other answer is a failed read (the failure line), never a silent empty list (PO 23:57Z).
      const json: unknown = await res.json();
      if (!Array.isArray(json)) { setLoadFailed(true); return; }
      const list = json as UserBlockRow[];
      setRows(list);
      // story #4444 — the list carries the name (a person without a project row has no team-member route to read it from);
      // only rows without it (an older server) are looked up one by one
      const named = list.filter((r) => r.blocked_member_name !== undefined);
      if (named.length > 0) {
        setMemberMap((prev) => ({ ...prev, ...Object.fromEntries(named.map((r) => [r.blocked_member_id, { name: r.blocked_member_name ?? null }])) }));
      }
      const missing = list.filter((r) => r.blocked_member_name === undefined).map((r) => r.blocked_member_id).filter((id) => !(id in memberMap));
      if (missing.length > 0) {
        const entries = await Promise.all(missing.map(async (id) => {
          try {
            const r = await fetchWithAuth(`/api/team-members/${id}`);
            if (!r.ok) return null;
            const j = await r.json() as { data?: { name?: string | null } };
            return j.data ? [id, { name: j.data.name ?? null }] as const : null;
          } catch {
            return null;
          }
        }));
        setMemberMap((prev) => ({ ...prev, ...Object.fromEntries(entries.filter((e) => e !== null)) }));
      }
    } catch {
      setLoadFailed(true);
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

  if (loading) return null;
  if (loadFailed) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{t('blockedUsersTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('blockedUsersSubtitle')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="blocked-users-load-failed">
            {t('blockedUsersLoadFailed')}
            <Button variant="outline" size="sm" onClick={() => void fetchBlocks()}>{tc('retry')}</Button>
          </p>
        </SectionCardBody>
      </SectionCard>
    );
  }
  if (rows.length === 0) return null;

  // 목록 행이라 같은 폴백 글자가 서로 다른 사람 둘 이상이면 그 행에만 «· ID 앞 8자»(꼬리 규칙 한 곳 · tailSharedFallbacks).
  const rowLabels = disambiguateFallbackLabels(rows.map((row) => ({
    id: row.blocked_member_id,
    label: memberNameById(memberMap, row.blocked_member_id, tc, tc('memberUnknown')),
    fallback: !memberMap[row.blocked_member_id]?.name,
  })));

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('blockedUsersTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('blockedUsersSubtitle')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="divide-y divide-border">
        {rows.map((row, index) => {
          // story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 「차단 해제」 접근 이름이라
          // 보조기술 버튼 목록에서 어느 사용자 행인지 못 가른다. 순번+현재 보이는 라벨을
          // 그대로 품는 aria-label로 가른다(새 낱말 0 — 보이는 글자는 불변).
          // story #3608(유나 §22-18 ④-2) — "..."는 위 aria-label 안에도 그대로
          // 들어가 "3번째 ..."이 됐다(발견 시점 실측). 낱말("해제 중…")로.
          const visibleLabel = busyId === row.blocked_member_id ? t('unblockUserUnblocking') : t('unblockUserAction');
          return (
            <div key={row.blocked_member_id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="flex items-center gap-2 text-sm text-foreground">
                <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />
                {rowLabels.get(row.blocked_member_id)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleUnblock(row.blocked_member_id)}
                disabled={busyId === row.blocked_member_id}
                aria-label={t('unblockUserAriaLabel', { n: index + 1, label: visibleLabel })}
              >
                {visibleLabel}
              </Button>
            </div>
          );
        })}
      </SectionCardBody>
    </SectionCard>
  );
}
