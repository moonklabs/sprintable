'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { OperatorInput } from '@/components/ui/operator-control';

interface MeetingItem {
  id: string;
  title: string;
  meeting_type: string;
  date: string;
  duration_min: number | null;
  participants: unknown[];
  ai_summary: string | null;
}

const TYPE_BADGE_VARIANT: Record<string, 'success' | 'secondary' | 'outline' | 'info'> = {
  standup: 'success',
  retro: 'secondary',
  general: 'outline',
  review: 'info',
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
    fetch('/api/meetings')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { setMeetings(json?.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = meetings.filter((m) => {
    if (typeFilter && m.meeting_type !== typeFilter) return false;
    if (dateFrom && new Date(m.date) < new Date(dateFrom)) return false;
    if (dateTo && new Date(m.date) > new Date(`${dateTo}T23:59:59`)) return false;
    return true;
  });

  if (loading) return <PageSkeleton />;

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('meetings')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => router.push('/meetings/new')}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newMeeting')}
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Filters */}
        <div className="flex-shrink-0 border-b border-border/80 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36">
              <OperatorDropdownSelect
                value={typeFilter}
                onValueChange={setTypeFilter}
                options={[
                  { value: '', label: t('allTypes') },
                  { value: 'standup', label: t('standup') },
                  { value: 'retro', label: t('retro') },
                  { value: 'general', label: t('general') },
                  { value: 'review', label: t('review') },
                ]}
              />
            </div>
            <OperatorInput
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-auto"
            />
            <span className="text-xs text-muted-foreground">~</span>
            <OperatorInput
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-auto"
            />
          </div>
        </div>

        {/* Meeting list */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {filtered.length === 0 ? (
            <EmptyState title={t('noMeetings')} description="" />
          ) : (
            <div className="space-y-2">
              {filtered.map((m) => (
                <div
                  key={m.id}
                  onClick={() => router.push(`/meetings/${m.id}`)}
                  className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border bg-background p-4 transition hover:border-primary/30 hover:bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{m.title}</h3>
                      <Badge variant={TYPE_BADGE_VARIANT[m.meeting_type] ?? 'outline'}>
                        {t(m.meeting_type as 'standup' | 'retro' | 'general' | 'review')}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(m.date).toLocaleDateString()}{m.duration_min ? ` · ${m.duration_min}min` : ''}
                    </p>
                    {m.ai_summary ? (
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{m.ai_summary}</p>
                    ) : null}
                  </div>
                  {(m.participants as Array<{ name?: string }>).length > 0 ? (
                    <div className="flex flex-shrink-0 -space-x-1">
                      {(m.participants as Array<{ name?: string }>).slice(0, 4).map((p, i) => (
                        <div key={i} className="flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] font-medium text-foreground">
                          {(p.name ?? '?')[0]}
                        </div>
                      ))}
                      {m.participants.length > 4 ? (
                        <div className="flex h-6 w-6 items-center justify-center rounded-full border border-background bg-muted text-[10px] text-muted-foreground">
                          +{m.participants.length - 4}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
