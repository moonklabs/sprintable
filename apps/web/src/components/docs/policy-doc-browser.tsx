'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';

interface Sprint {
  id: string;
  title: string;
  status: string;
}

interface PolicyDocument {
  id: string;
  sprint_id: string;
  epic_id: string;
  title: string;
  content: string;
  updated_at: string;
  sprint?: { id: string; title: string; status: string } | null;
  epic?: { id: string; title: string; status?: string | null } | null;
}

interface PolicyDocBrowserProps {
  projectId?: string;
  t: (key: string) => string;
}

export function shouldClosePolicyPanelAfterSelection(mode: 'inline' | 'drawer') {
  return mode === 'drawer';
}

export function PolicyDocBrowser({ projectId, t }: PolicyDocBrowserProps) {
  const [loading, setLoading] = useState(true);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [docs, setDocs] = useState<PolicyDocument[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const policyPanelStorageKey = useMemo(() => `docs:policy-sprints-panel:${projectId ?? 'no-project'}`, [projectId]);
  const {
    inlinePanelOpen: policyPanelInlineOpen,
    drawerOpen: policyPanelDrawerOpen,
    setDrawerOpen: setPolicyPanelDrawerOpen,
    togglePanel: togglePolicyPanel,
  } = useContextualPanelState({ storageKey: policyPanelStorageKey, defaultOpen: true });

  useEffect(() => {
    let cancelled = false;

    async function loadSprints() {
      if (!projectId) return;
      setLoading(true);
      try {
        const sprintsRes = await fetch(`/api/sprints?project_id=${projectId}`);
        if (!sprintsRes.ok) return;
        const sprintsJson = await sprintsRes.json();
        if (cancelled) return;

        const loadedSprints = (sprintsJson.data ?? []) as Sprint[];
        setSprints(loadedSprints);
        const activeSprint = loadedSprints.find((sprint) => sprint.status === 'active');
        setSelectedSprintId(activeSprint?.id ?? loadedSprints[0]?.id ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSprints();
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadDocs() {
      if (!projectId || !selectedSprintId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ project_id: projectId, sprint_id: selectedSprintId });
        if (query.trim()) params.set('q', query.trim());
        const res = await fetch(`/api/policy-documents?${params.toString()}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setDocs((json.data ?? []) as PolicyDocument[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadDocs();
    return () => { cancelled = true; };
  }, [projectId, selectedSprintId, query]);

  useEffect(() => {
    if (!docs.length) {
      setSelectedDocId(null);
      return;
    }
    if (!docs.some((doc) => doc.id === selectedDocId)) {
      setSelectedDocId(docs[0].id);
    }
  }, [docs, selectedDocId]);

  const selectedDoc = useMemo(() => docs.find((doc) => doc.id === selectedDocId) ?? null, [docs, selectedDocId]);
  const policyPanelToggleLabel = policyPanelInlineOpen || policyPanelDrawerOpen ? t('hidePolicySprints') : t('openPolicySprints');

  const renderSprintSidebar = ({ mode, closePanel }: { mode: 'inline' | 'drawer'; closePanel: () => void }) => (
    <GlassPanel className="flex h-full min-h-0 flex-col overflow-hidden border-white/8 bg-[color:var(--operator-surface-soft)]/75">
      <div className="space-y-4 overflow-y-auto p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--operator-muted)]">{t('policySprints')}</div>
            <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t('policySprintsDescription')}</p>
          </div>
          {mode === 'drawer' ? (
            <Button variant="glass" size="icon-sm" aria-label={t('hidePolicySprints')} onClick={closePanel}>
              <X />
            </Button>
          ) : null}
        </div>
        {loading && sprints.length === 0 ? (
          <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
        ) : sprints.length === 0 ? (
          <p className="text-sm text-[color:var(--operator-muted)]">{t('noSprints')}</p>
        ) : (
          <div className="space-y-2">
            {sprints.map((sprint) => {
              const isSelected = sprint.id === selectedSprintId;
              const isActive = sprint.status === 'active';
              return (
                <button
                  key={sprint.id}
                  onClick={() => {
                    setSelectedSprintId(sprint.id);
                    if (shouldClosePolicyPanelAfterSelection(mode)) closePanel();
                  }}
                  className={cn(
                    'w-full rounded-2xl border px-3 py-3 text-left text-sm transition-all',
                    isSelected
                      ? 'border-[color:var(--operator-primary)]/20 bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]'
                      : 'border-white/8 bg-white/5 text-[color:var(--operator-foreground)]/88 hover:bg-white/8',
                  )}
                >
                  <div className="font-medium">{sprint.title}</div>
                  {isActive ? <div className="mt-1 text-[11px] text-[color:var(--operator-tertiary)]">{t('activeSprint')}</div> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </GlassPanel>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="glass" size="sm" onClick={togglePolicyPanel}>
          <Menu />
          {policyPanelToggleLabel}
        </Button>
        {selectedSprintId ? (
          <div className="rounded-full border border-white/8 bg-white/5 px-3 py-1.5 text-xs text-[color:var(--operator-muted)]">
            {sprints.find((sprint) => sprint.id === selectedSprintId)?.title ?? t('policySprints')}
          </div>
        ) : null}
      </div>

      <ContextualPanelLayout
        renderPanel={renderSprintSidebar}
        inlinePanelOpen={policyPanelInlineOpen}
        drawerOpen={policyPanelDrawerOpen}
        onDrawerOpenChange={setPolicyPanelDrawerOpen}
        drawerAriaLabel={t('openPolicySprints')}
        className="min-h-0 flex-1"
        inlineColumnsClassName="2xl:grid-cols-[280px_minmax(0,1fr)]"
      >
        <div className="grid gap-4 p-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="flex flex-col min-h-0">
            <div className="border-b border-white/8 px-4 py-4">
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('policyEpics')}</div>
                  <div className="mt-1 text-sm text-[color:var(--operator-muted)]">{t('policyEpicsDescription')}</div>
                </div>
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('policySearchPlaceholder')}
                  className="w-full rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/90 px-4 py-2.5 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:border-[color:var(--operator-primary)]/20 focus:outline-none"
                />
              </div>
            </div>
            <div className="px-4 py-4">
              {loading ? (
                <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
              ) : docs.length === 0 ? (
                <p className="text-sm text-[color:var(--operator-muted)]">{t('noPolicyEpics')}</p>
              ) : (
                <div className="space-y-2">
                  {docs.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    return (
                      <button
                        key={doc.id}
                        onClick={() => {
                          setSelectedDocId(doc.id);
                          setPolicyPanelDrawerOpen(false);
                        }}
                        className={cn(
                          'w-full rounded-2xl border px-3 py-3 text-left text-sm transition-all',
                          isSelected
                            ? 'border-[color:var(--operator-primary)]/20 bg-[color:var(--operator-primary)]/14 text-[color:var(--operator-primary-soft)]'
                            : 'border-white/8 bg-white/5 text-[color:var(--operator-foreground)]/88 hover:bg-white/8',
                        )}
                      >
                        <div className="font-medium">{doc.title || doc.epic?.title || t('untitledPolicyDoc')}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col min-h-0">
            <div className="border-b border-white/8 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{selectedDoc?.title || selectedDoc?.epic?.title || t('selectPolicyEpic')}</div>
                  {selectedDoc ? <div className="mt-1 text-xs text-[color:var(--operator-muted)]">{t('lastUpdated')}: {new Date(selectedDoc.updated_at).toLocaleString()}</div> : null}
                </div>
              </div>
            </div>
            <div className="px-4 py-4">
              {selectedDoc ? (
                <div className="prose prose-invert prose-sm max-w-none text-[color:var(--operator-foreground)]">
                  <ReactMarkdown>{selectedDoc.content?.trim() || t('emptyPolicyEpic')}</ReactMarkdown>
                </div>
              ) : (
                <div className="flex min-h-[280px] items-center justify-center text-sm text-[color:var(--operator-muted)]">
                  {t('selectPolicyEpic')}
                </div>
              )}
            </div>
          </div>
        </div>
      </ContextualPanelLayout>
    </div>
  );
}
