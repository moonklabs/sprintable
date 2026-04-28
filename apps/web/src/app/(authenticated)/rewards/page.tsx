'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { OperatorInput } from '@/components/ui/operator-control';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

interface LedgerEntry { id: string; member_id: string; amount: number; reason: string; created_at: string }
interface LeaderboardEntry { member_id: string; balance: number }
interface Member { id: string; name: string; type: string }

type Period = 'all' | 'daily' | 'weekly' | 'monthly';

export default function RewardsPage() {
  const t = useTranslations('rewards');
  const shellT = useTranslations('shell');
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
          fetch(`/api/rewards/leaderboard?project_id=${projectId}&period=${period}`),
          fetch(`/api/rewards?project_id=${projectId}`),
          fetch(`/api/team-members?project_id=${projectId}`),
        ]);
        if (lbRes.ok && !cancelled) { const j = await lbRes.json(); setLeaderboard(j.data ?? []); }
        if (ledgerRes.ok && !cancelled) { const j = await ledgerRes.json(); setLedger(j.data ?? []); }
        if (membersRes.ok && !cancelled) { const j = await membersRes.json(); setMembers(j.data ?? []); }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
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

  if (!projectId) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center p-6">
          <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 p-6">

          {/* 리더보드 */}
          <div className="rounded-xl border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">🏆 {t('leaderboard')}</h2>
              <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
                {PERIOD_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPeriod(opt.value)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      period === opt.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4">
              {loading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/50" />)}
                </div>
              ) : leaderboard.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noData')}</p>
              ) : (
                <div className="space-y-2">
                  {leaderboard.map((e, i) => (
                    <div key={e.member_id} className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-2">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline">#{i + 1}</Badge>
                        <span className="text-sm font-medium text-foreground">{memberMap[e.member_id] ?? t('unknown')}</span>
                      </div>
                      <span className={`text-sm font-bold ${e.balance >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                        {e.balance >= 0 ? '+' : ''}{e.balance.toLocaleString()} TJSB
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 포상/벌금 지급 */}
          <div className="rounded-xl border border-border bg-background">
            <div className="border-b border-border/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">💰 {t('grantReward')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
            </div>
            <div className="p-4">
              {grantError ? <p className="mb-3 text-xs text-destructive">{grantError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <div className="w-40">
                  <OperatorDropdownSelect
                    value={memberId}
                    onValueChange={setMemberId}
                    options={[
                      { value: '', label: t('selectMember') },
                      ...members.map((m) => ({ value: m.id, label: m.name })),
                    ]}
                  />
                </div>
                <OperatorInput
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t('amountPlaceholder')}
                  className="w-28"
                />
                <OperatorInput
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('reasonPlaceholder')}
                  className="flex-1 min-w-32"
                />
                <Button
                  variant="default"
                  onClick={handleGrant}
                  disabled={!memberId || !amount || !reason.trim() || granting}
                >
                  {granting ? t('granting') : t('grant')}
                </Button>
              </div>
            </div>
          </div>

          {/* 거래 내역 */}
          <div className="rounded-xl border border-border bg-background">
            <div className="border-b border-border/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">📋 {t('history')}</h2>
            </div>
            <div className="p-4">
              {ledger.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noHistory')}</p>
              ) : (
                <div className="space-y-2">
                  {ledger.slice(0, 20).map((e) => (
                    <div key={e.id} className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">{memberMap[e.member_id] ?? t('unknown')}</p>
                        <p className="text-xs text-muted-foreground">{e.reason}</p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${e.amount >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                          {e.amount >= 0 ? '+' : ''}{e.amount.toLocaleString()} TJSB
                        </p>
                        <p className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleDateString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
