'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

interface LedgerEntry { id: string; member_id: string; amount: number; reason: string; created_at: string }
interface LeaderboardEntry { member_id: string; balance: number }
interface Member { id: string; name: string; type: string }

export default function RewardsPage() {
  const t = useTranslations('rewards');
  const shellT = useTranslations('shell');
  const { projectId, currentTeamMemberId } = useDashboardContext();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'all' | 'daily' | 'weekly' | 'monthly'>('all');
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState('');
  // admin 여부는 grant 실패 응답으로 판별

  const memberMap: Record<string, string> = {};
  for (const m of members) memberMap[m.id] = m.name;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) {
        if (!cancelled) {
          setLeaderboard([]);
          setLedger([]);
          setMembers([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      try {
        const [lbRes, ledgerRes, membersRes] = await Promise.all([
          fetch(`/api/rewards/leaderboard?project_id=${projectId}&period=${period}`),
          fetch(`/api/rewards?project_id=${projectId}`),
          fetch(`/api/team-members?project_id=${projectId}`),
        ]);
        if (lbRes.ok && !cancelled) { const j = await lbRes.json(); setLeaderboard(j.data); }
        if (ledgerRes.ok && !cancelled) { const j = await ledgerRes.json(); setLedger(j.data); }
        if (membersRes.ok && !cancelled) { const j = await membersRes.json(); setMembers(j.data); }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, period]);

  const handleGrant = async () => {
    if (!memberId || !amount || !reason.trim()) return;
    setGranting(true);
    setGrantError('');
    try {
      const res = await fetch('/api/rewards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, amount: Number(amount), reason: reason.trim() }),
      });
      if (res.ok) {
        setMemberId(''); setAmount(''); setReason('');
        const [lbRes, ledgerRes] = await Promise.all([
          fetch(`/api/rewards/leaderboard?project_id=${projectId}&period=${period}`),
          fetch(`/api/rewards?project_id=${projectId}`),
        ]);
        if (lbRes.ok) { const j = await lbRes.json(); setLeaderboard(j.data); }
        if (ledgerRes.ok) { const j = await ledgerRes.json(); setLedger(j.data); }
      } else {
        const errData = await res.json().catch(() => ({ data: null, error: { code: 'UNKNOWN', message: 'Unknown error' }, meta: null }));
        setGrantError(res.status === 403 ? t('adminOnly') : (errData.error?.message ?? t('grantFailed')));
      }
    } catch {
      setGrantError(t('grantFailed'));
    }
    setGranting(false);
  };

  if (!projectId) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <div className="rounded-xl bg-white p-8 shadow-sm">
            <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>

        {/* 리더보드 */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">🏆 {t('leaderboard')}</h2>
            <div className="flex gap-1 rounded-lg bg-gray-100 p-1 text-xs">
              {(['all', 'monthly', 'weekly', 'daily'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded-md px-2 py-1 transition-colors ${period === p ? 'bg-white font-medium shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  {p === 'all' ? t('periodAll') : p === 'monthly' ? t('periodMonthly') : p === 'weekly' ? t('periodWeekly') : t('periodDaily')}
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-8 animate-pulse rounded bg-gray-100" />)}</div>
          ) : leaderboard.length === 0 ? (
            <p className="text-sm text-gray-400">{t('noData')}</p>
          ) : (
            <div className="space-y-2">
              {leaderboard.map((e, i) => (
                <div key={e.member_id} className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-gray-400">#{i + 1}</span>
                    <span className="text-sm font-medium text-gray-900">{memberMap[e.member_id] ?? t('unknown')}</span>
                  </div>
                  <span className={`text-sm font-bold ${e.balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>{e.balance.toLocaleString()} TJSB</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 포상/벌금 지급 */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">💰 {t('grantReward')}</h2>
          <p className="mb-2 text-xs text-gray-400">{t('adminOnlyHint')}</p>
          {grantError && <p className="mb-2 text-xs text-red-500">{grantError}</p>}
          <div className="flex flex-wrap gap-3">
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="rounded-lg border px-3 py-1.5 text-sm">
              <option value="">{t('selectMember')}</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('amountPlaceholder')} className="w-32 rounded-lg border px-3 py-1.5 text-sm" />
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPlaceholder')} className="flex-1 rounded-lg border px-3 py-1.5 text-sm" />
            <button onClick={handleGrant} disabled={!memberId || !amount || !reason.trim() || granting}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {granting ? t('granting') : t('grant')}
            </button>
          </div>
        </div>

        {/* 거래 내역 */}
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">📋 {t('history')}</h2>
          {ledger.length === 0 ? (
            <p className="text-sm text-gray-400">{t('noHistory')}</p>
          ) : (
            <div className="space-y-2">
              {ledger.slice(0, 20).map(e => (
                <div key={e.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-4 py-2">
                  <div>
                    <p className="text-sm text-gray-900">{memberMap[e.member_id] ?? t('unknown')}</p>
                    <p className="text-xs text-gray-500">{e.reason}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${e.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {e.amount >= 0 ? '+' : ''}{e.amount.toLocaleString()} TJSB
                    </p>
                    <p className="text-xs text-gray-400">{new Date(e.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
