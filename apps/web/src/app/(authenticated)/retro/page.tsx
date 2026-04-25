'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../dashboard/dashboard-shell';

interface RetroSession {
  id: string;
  title: string;
  phase: string;
  created_at: string;
}

const PHASE_VARIANTS: Record<string, 'success' | 'info' | 'outline' | 'secondary'> = {
  collect: 'info',
  group: 'secondary',
  vote: 'outline',
  discuss: 'secondary',
  action: 'success',
  closed: 'outline',
};

export default function RetroPage() {
  const t = useTranslations('retro');
  const shellT = useTranslations('shell');
  const { projectId } = useDashboardContext();
  const [sessions, setSessions] = useState<RetroSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) {
        if (!cancelled) {
          setSessions([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/retro?project_id=${projectId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setSessions(json.data ?? []);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  const handleCreate = async () => {
    if (!title.trim() || !projectId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/retro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), project_id: projectId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSessions((prev) => [json.data, ...prev]);
      setTitle('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  const PHASE_KEYS: Record<string, string> = {
    collect: 'phaseCollect',
    group: 'phaseGroup',
    vote: 'phaseVote',
    discuss: 'phaseDiscuss',
    action: 'phaseAction',
    closed: 'phaseClosed',
  };

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
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => document.getElementById('retro-title-input')?.focus()}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newSession')}
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto">
        {/* Create new session */}
        <div className="flex-shrink-0 border-b border-border/80 px-6 py-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('newSession')}
          </p>
          <div className="flex gap-2">
            <Input
              id="retro-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              placeholder={t('newSessionPlaceholder')}
              className="flex-1"
            />
            <Button variant="default" onClick={handleCreate} disabled={!title.trim() || creating}>
              {creating ? t('creating') : t('create')}
            </Button>
          </div>
          {createError ? (
            <p className="mt-2 text-xs text-destructive">{createError}</p>
          ) : null}
        </div>

        {/* Session list */}
        <div className="flex-1 px-6 py-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('sessionList')}
          </p>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : loadError ? (
            <EmptyState title={loadError} description={t('surfaceDescription')} />
          ) : sessions.length === 0 ? (
            <EmptyState title={t('noSessions')} description={t('surfaceDescription')} />
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{session.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(session.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge variant={PHASE_VARIANTS[session.phase] ?? 'outline'}>
                    {PHASE_KEYS[session.phase] ? t(PHASE_KEYS[session.phase] as 'phaseCollect') : session.phase}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
