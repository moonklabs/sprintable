'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageSkeleton } from '@/components/ui/page-skeleton';

interface MeetingItem {
  id: string;
  title: string;
  meeting_type: string;
  date: string;
  duration_min: number | null;
  participants: unknown[];
  ai_summary: string | null;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  standup: { label: 'standup', color: 'bg-green-100 text-green-700' },
  retro: { label: 'retro', color: 'bg-purple-100 text-purple-700' },
  general: { label: 'general', color: 'bg-gray-100 text-gray-600' },
  review: { label: 'review', color: 'bg-blue-100 text-blue-700' },
};

export default function MeetingsPage() {
  const t = useTranslations('meeting');
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    fetch('/api/meetings').then(r => r.ok ? r.json() : null).then(json => {
      setMeetings(json?.data ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = meetings.filter(m => {
    if (typeFilter && m.meeting_type !== typeFilter) return false;
    if (dateFrom && new Date(m.date) < new Date(dateFrom)) return false;
    if (dateTo && new Date(m.date) > new Date(dateTo + 'T23:59:59')) return false;
    return true;
  });

  if (loading) return <PageSkeleton />;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">{t('meetings')}</h1>
        <button onClick={() => router.push('/meetings/new')} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          + {t('newMeeting')}
        </button>
      </div>

      {/* AC2: 필터 */}
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs">
          <option value="">{t('allTypes')}</option>
          <option value="standup">{t('standup')}</option>
          <option value="retro">{t('retro')}</option>
          <option value="general">{t('general')}</option>
          <option value="review">{t('review')}</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs" placeholder={t('dateRange')} />
        <span className="self-center text-xs text-gray-400">~</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs" />
      </div>

      {/* AC1: 카드 리스트 */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center text-sm text-gray-400">{t('noMeetings')}</div>
      ) : (
        <div className="space-y-3">
          {filtered.map(m => {
            const badge = TYPE_BADGE[m.meeting_type] ?? TYPE_BADGE.general;
            return (
              <div key={m.id} onClick={() => router.push(`/meetings/${m.id}`)} className="cursor-pointer rounded-lg border border-gray-200 p-4 transition hover:border-blue-300 hover:shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900">{m.title}</h3>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.color}`}>{t(badge.label as 'standup' | 'retro' | 'general' | 'review')}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">{new Date(m.date).toLocaleDateString()} {m.duration_min ? `· ${m.duration_min}min` : ''}</p>
                    {m.ai_summary && <p className="mt-2 line-clamp-2 text-xs text-gray-600">{m.ai_summary}</p>}
                  </div>
                  {m.participants.length > 0 && (
                    <div className="flex -space-x-1">
                      {(m.participants as Array<{ name?: string }>).slice(0, 4).map((p, i) => (
                        <div key={i} className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-[10px] font-medium text-gray-600">
                          {(p.name ?? '?')[0]}
                        </div>
                      ))}
                      {m.participants.length > 4 && <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[10px] text-gray-400">+{m.participants.length - 4}</div>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
