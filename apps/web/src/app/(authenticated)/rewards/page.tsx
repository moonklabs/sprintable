'use client';

import { useState, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { memberOptionLabels } from '@/lib/member-display';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { EmptyState } from '@/components/ds/empty-state';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { PageFrame } from '@/components/ds/page-frame';
import { RowList, RowListItem } from '@/components/ds/row-list';
import { NativeSelect } from '@/components/ds/select';
import { SectionHeader } from '@/components/ds/section-header';
import { Skeleton } from '@/components/ds/skeleton';
import { OrgScreenTitle } from '@/components/organization/org-screen-title';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface LedgerEntry { id: string; member_id: string; amount: number; reason: string; created_at: string }
interface LeaderboardEntry { member_id: string; balance: number }
interface Member { id: string; name: string; type: string }

type Period = 'all' | 'daily' | 'weekly' | 'monthly';

export default function RewardsPage() {
  const t = useTranslations('rewards');
  const tc = useTranslations('common');
  const shellT = useTranslations('shell');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const { projectId } = useDashboardContext();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('all');
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState('');

  const memberMap: Record<string, string> = {};
  for (const m of members) memberMap[m.id] = m.name;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) {
        if (!cancelled) { setLeaderboard([]); setLedger([]); setMembers([]); setLoading(false); }
        return;
      }
      setLoading(true);
      try {
        const [lbRes, ledgerRes, membersRes] = await Promise.all([
          fetchWithAuth(`/api/rewards/leaderboard?project_id=${projectId}&period=${period}`),
          fetchWithAuth(`/api/rewards?project_id=${projectId}`),
          fetchWithAuth(`/api/team-members?project_id=${projectId}`),
        ]);
        if (lbRes.ok && !cancelled) { const j = await lbRes.json(); setLeaderboard(j.data ?? []); }
        if (ledgerRes.ok && !cancelled) { const j = await ledgerRes.json(); setLedger(j.data ?? []); }
        if (membersRes.ok && !cancelled) { const j = await membersRes.json(); setMembers(j.data ?? []); }
      } catch { /* silent */ } finally {
        // 실패/예외 무관 loading 해소 (#1242 settings 패턴) — 무한 스켈레톤 방지.
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, period]);

  const handleGrant = async () => {
    if (!memberId || !amount || !reason.trim() || !projectId) return;
    setGranting(true);
    setGrantError('');
    try {
      const res = await fetch('/api/rewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, member_id: memberId, amount: Number(amount), reason: reason.trim() }),
      });
      if (res.ok) {
        const j = await res.json();
        setLedger((prev) => [j.data, ...prev]);
        setMemberId(''); setAmount(''); setReason('');
      } else {
        setGrantError(t('grantFailed'));
      }
    } catch {
      setGrantError(t('grantFailed'));
    }
    setGranting(false);
  };

  const PERIOD_OPTIONS: { value: Period; label: string }[] = [
    { value: 'all', label: t('periodAll') },
    { value: 'monthly', label: t('periodMonthly') },
    { value: 'weekly', label: t('periodWeekly') },
    { value: 'daily', label: t('periodDaily') },
  ];

  // 4913 — 제목은 위 막대(프로젝트 칩 켬 · 폴백 표의 rewards와 같은 모양), 본문은 한 쪽 틀(reading). 모든 분기에서 제목 유지.
  if (!projectId) {
    return (
      <>
        <OrgScreenTitle showContextChip>{t('title')}</OrgScreenTitle>
        <PageFrame width="reading">
          <Card>
            <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
          </Card>
        </PageFrame>
      </>
    );
  }

  const balanceClass = (n: number) => cn('font-mono text-ds-body font-semibold', n >= 0 ? 'text-ds-done' : 'text-ds-failed');

  return (
    <>
      <OrgScreenTitle showContextChip>{t('title')}</OrgScreenTitle>
      <PageFrame width="reading">
        {/* 리더보드 — 기간 고르기는 구획 머리 오른쪽(켜진 칸은 aria-pressed + 선택 면 · 색만으로 뜻을 싣지 않는다). */}
        <RowList
          aria-label={t('leaderboard')}
          header={{
            title: t('leaderboard'),
            level: 2,
            trailing: (
              <span className="flex items-center gap-1">
                {PERIOD_OPTIONS.map((opt) => (
                  <Button
                    key={opt.value}
                    type="button"
                    variant="quiet"
                    aria-pressed={period === opt.value}
                    onClick={() => setPeriod(opt.value)}
                    className={cn(period === opt.value && 'bg-ds-action-soft text-ds-action-text hover:bg-ds-action-soft')}
                  >
                    {opt.label}
                  </Button>
                ))}
              </span>
            ),
          }}
        >
          {loading ? (
            <div role="listitem" className="space-y-2 p-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : leaderboard.length === 0 ? (
            <div role="listitem"><EmptyState size="inline" title={t('noData')} /></div>
          ) : (
            leaderboard.map((e, i) => (
              <RowListItem
                key={e.member_id}
                leading={<Chip mono>#{i + 1}</Chip>}
                title={memberMap[e.member_id] ?? t('unknown')}
                statusMark={(
                  <span className={balanceClass(e.balance)}>
                    {e.balance >= 0 ? '+' : ''}{e.balance.toLocaleString()} TJSB
                  </span>
                )}
              />
            ))
          )}
        </RowList>

        {/* 포상/벌금 지급 — 목록이 아니라 폼이라 행이 없는 패널 */}
        <Card>
          <SectionHeader title={t('grantReward')} level={2} />
          <div className="flex flex-col gap-3 p-4">
            <p className="m-0 text-ds-small text-ds-ink-3">{t('adminOnlyHint')}</p>
            {grantError ? <Banner tone="failed">{grantError}</Banner> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('selectMember')}>
                {(c) => (
                  <NativeSelect {...c} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                    <option value="" />
                    {((labels) => members.map((m) => <option key={m.id} value={m.id}>{labels.get(m.id) ?? ''}</option>))(memberOptionLabels(members, tc))}
                  </NativeSelect>
                )}
              </Field>
              <Field label={t('amountPlaceholder')}>
                {(c) => <Input {...c} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            </div>
            {/* 자리표시 글("사유...")의 말줄임만 걷어 보이는 이름으로 쓴다 — 새 낱말 0. */}
            <Field label={t('reasonPlaceholder').replace(/[.…]+$/, '')}>
              {(c) => <Input {...c} type="text" value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" onClick={handleGrant} disabled={!memberId || !amount || !reason.trim() || granting}>
                {granting ? t('granting') : t('grant')}
              </Button>
            </div>
          </div>
        </Card>

        {/* 거래 내역 */}
        <RowList aria-label={t('history')} header={{ title: t('history'), level: 2 }}>
          {ledger.length === 0 ? (
            <div role="listitem"><EmptyState size="inline" title={t('noHistory')} /></div>
          ) : (
            ledger.slice(0, 20).map((e) => (
              <RowListItem
                key={e.id}
                title={memberMap[e.member_id] ?? t('unknown')}
                subtitle={<span className="whitespace-normal break-keep font-sans [overflow-wrap:anywhere]">{e.reason}</span>}
                statusMark={
                  <span className="flex flex-col items-end">
                    <span className={balanceClass(e.amount)}>
                      {e.amount >= 0 ? '+' : ''}{e.amount.toLocaleString()} TJSB
                    </span>
                    <span className="text-ds-small text-ds-ink-3">{formatViewerRelativeTime(e.created_at, locale, displayTimezone)}</span>
                  </span>
                }
              />
            ))
          )}
        </RowList>
      </PageFrame>
    </>
  );
}
