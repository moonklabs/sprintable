'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorInput } from '@/components/ui/operator-control';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
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
  const tc = useTranslations('common');
  const shellT = useTranslations('shell');
  const { projectId } = useDashboardContext();
  const [sessions, setSessions] = useState<RetroSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

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
      try {
        const res = await fetch(`/api/retro?project_id=${projectId}`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          setSessions(json.data);
        }
      } catch {
        // silent
      }
      if (!cancelled) setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/retro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (res.ok) {
        const json = await res.json();
        setSessions((prev) => [json.data, ...prev]);
        setTitle('');
      }
    } catch {
      // silent
    }
    setCreating(false);
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
      <div className="space-y-4">
        <PageHeader
          eyebrow={tc('operatorSurface')}
          title={t('title')}
          description={t('surfaceDescription')}
        />
        <SectionCard>
          <SectionCardBody>
            <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={tc('operatorSurface')}
        title={t('title')}
        description={t('surfaceDescription')}
      />

      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{t('newSession')}</h2>
            <p className="text-sm text-muted-foreground">{t('surfaceDescription')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="flex flex-col gap-3 md:flex-row">
            <OperatorInput
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('newSessionPlaceholder')}
              className="flex-1"
            />
            <Button variant="hero" size="lg" onClick={handleCreate} disabled={!title.trim() || creating}>
              {creating ? t('creating') : t('newSession')}
            </Button>
          </div>
        </SectionCardBody>
      </SectionCard>

      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{t('sessionList')}</h2>
            <p className="text-sm text-muted-foreground">{t('surfaceDescription')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {loading ? (
            <div className="space-y-3">{[1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-md bg-muted" />)}</div>
          ) : sessions.length === 0 ? (
            <EmptyState title={t('noSessions')} description={t('surfaceDescription')} />
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div key={session.id} className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 shadow-sm md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">{session.title}</p>
                    <p className="text-xs text-muted-foreground">{new Date(session.created_at).toLocaleDateString()}</p>
                  </div>
                  <Badge variant={PHASE_VARIANTS[session.phase] ?? 'outline'}>
                    {PHASE_KEYS[session.phase] ? t(PHASE_KEYS[session.phase] as 'phaseCollect') : session.phase}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
