'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

interface Sprint {
  id: string;
  title: string;
  status: string;
  start_date: string;
  end_date: string;
  duration: number;
  velocity: number | null;
  report_doc_id: string | null;
}

interface BurndownData {
  total_points: number;
  done_points: number;
  remaining_points: number;
  completion_pct: number;
  stories_count: number;
  done_count: number;
  ideal_line: Array<{ date: string; points: number }>;
  actual_line: Array<{ date: string; points: number }>;
}

interface SprintsClientProps {
  projectId: string;
  orgId: string;
}

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'closed') return 'secondary';
  return 'outline';
}

export function SprintsClient({ projectId }: SprintsClientProps) {
  const t = useTranslations('sprints');
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Sprint | null>(null);
  const [burndown, setBurndown] = useState<BurndownData | null>(null);
  const [loadingBurndown, setLoadingBurndown] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/sprints?project_id=${projectId}`);
        if (res.ok) {
          const json = await res.json();
          setSprints(json.data ?? []);
        }
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [projectId]);

  const handleSelect = async (sprint: Sprint) => {
    setSelected(sprint);
    setBurndown(null);
    setLoadingBurndown(true);
    try {
      const res = await fetch(`/api/sprints/${sprint.id}/burndown`);
      if (res.ok) {
        const json = await res.json();
        setBurndown(json.data);
      }
    } finally {
      setLoadingBurndown(false);
    }
  };

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
  }

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Sprint list */}
      <div className="flex w-full flex-col gap-3 overflow-y-auto p-6 lg:w-1/2">
        {sprints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSprints')}</p>
        ) : (
          <ul className="space-y-2">
            {sprints.map((sprint) => (
              <li
                key={sprint.id}
                onClick={() => void handleSelect(sprint)}
                className={`cursor-pointer rounded-lg border p-4 transition hover:bg-muted/40 ${selected?.id === sprint.id ? 'border-primary bg-muted/40' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{sprint.title}</span>
                  <Badge variant={statusVariant(sprint.status)}>{sprint.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sprint.start_date} ~ {sprint.end_date} · {sprint.duration}{t('days')}
                </p>
                {sprint.report_doc_id ? (
                  <a
                    href={`/docs?id=${sprint.report_doc_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    📄 {t('viewReport')}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Burndown detail */}
      {selected ? (
        <div className="hidden w-1/2 overflow-y-auto border-l border-border p-6 lg:block">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">{selected.title}</h2>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</Button>
          </div>

          {loadingBurndown ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('loading')}</p>
          ) : burndown ? (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-md border border-border bg-muted/30 p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{burndown.completion_pct}%</p>
                  <p className="text-xs text-muted-foreground">{t('completionRate')}</p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{burndown.done_points}<span className="text-sm text-muted-foreground">/{burndown.total_points}</span></p>
                  <p className="text-xs text-muted-foreground">SP</p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 p-3 text-center">
                  <p className="text-2xl font-bold text-foreground">{burndown.done_count}<span className="text-sm text-muted-foreground">/{burndown.stories_count}</span></p>
                  <p className="text-xs text-muted-foreground">{t('stories')}</p>
                </div>
              </div>

              {/* Ideal vs Actual line summary */}
              {burndown.ideal_line.length > 0 ? (
                <div className="rounded-md border border-border p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('burndown')}</p>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>📉 {t('idealLine')}: {burndown.ideal_line[0]?.points ?? 0} → 0</span>
                    <span>📊 {t('actualLine')}: {burndown.actual_line[0]?.points ?? 0} → {burndown.actual_line[burndown.actual_line.length - 1]?.points ?? 0}</span>
                  </div>
                </div>
              ) : null}

              {selected.report_doc_id ? (
                <a
                  href={`/docs?id=${selected.report_doc_id}`}
                  className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm font-medium text-primary hover:bg-primary/10 transition"
                >
                  📄 {t('viewReport')}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
    </>
  );
}
