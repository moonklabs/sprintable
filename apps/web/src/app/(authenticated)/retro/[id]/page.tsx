'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Download, ChevronRight, Plus, ThumbsUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RetroSession {
  id: string;
  title: string;
  phase: string;
}

interface RetroItem {
  id: string;
  category: string;
  text: string;
  vote_count: number;
}

interface RetroAction {
  id: string;
  title: string;
  status: string;
}

type Phase = 'collect' | 'group' | 'vote' | 'discuss' | 'action' | 'closed';

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASE_VARIANTS: Record<string, 'success' | 'info' | 'outline' | 'secondary'> = {
  collect: 'info',
  group: 'secondary',
  vote: 'outline',
  discuss: 'secondary',
  action: 'success',
  closed: 'outline',
};

const NEXT_PHASE: Record<string, Phase> = {
  collect: 'group',
  group: 'vote',
  vote: 'discuss',
  discuss: 'action',
  action: 'closed',
};

const CATEGORIES: Array<'good' | 'bad' | 'improve'> = ['good', 'bad', 'improve'];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RetroDetailPage() {
  const t = useTranslations('retro');
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { projectId } = useDashboardContext();

  const [session, setSession] = useState<RetroSession | null>(null);
  const [items, setItems] = useState<RetroItem[]>([]);
  const [actions, setActions] = useState<RetroAction[]>([]);
  const [loading, setLoading] = useState(true);

  const [newItemCategory, setNewItemCategory] = useState<'good' | 'bad' | 'improve'>('good');
  const [newItemText, setNewItemText] = useState('');
  const [addingItem, setAddingItem] = useState(false);

  const [newActionTitle, setNewActionTitle] = useState('');
  const [addingAction, setAddingAction] = useState(false);

  const [advancingPhase, setAdvancingPhase] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMd, setExportMd] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [sessRes, itemsRes, actionsRes] = await Promise.all([
        fetch(`/api/retro-sessions/${id}?project_id=${projectId}`),
        fetch(`/api/retro-sessions/${id}/items?project_id=${projectId}`),
        fetch(`/api/retro-sessions/${id}/actions?project_id=${projectId}`),
      ]);
      if (sessRes.ok) {
        const j = await sessRes.json();
        setSession(j.data as RetroSession);
      }
      if (itemsRes.ok) {
        const j = await itemsRes.json();
        setItems((j.data ?? []) as RetroItem[]);
      }
      if (actionsRes.ok) {
        const j = await actionsRes.json();
        setActions((j.data ?? []) as RetroAction[]);
      }
    } finally {
      setLoading(false);
    }
  }, [id, projectId]);

  useEffect(() => { void load(); }, [load]);

  const handleAddItem = async () => {
    if (!newItemText.trim() || !projectId) return;
    setAddingItem(true);
    try {
      const res = await fetch(`/api/retro-sessions/${id}/items?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: newItemCategory, text: newItemText.trim() }),
      });
      if (res.ok) {
        const j = await res.json();
        setItems((prev) => [...prev, j.data as RetroItem]);
        setNewItemText('');
      }
    } finally {
      setAddingItem(false);
    }
  };

  const handleVote = async (itemId: string) => {
    if (!projectId) return;
    await fetch(`/api/retro-sessions/${id}/items/${itemId}/vote?project_id=${projectId}`, { method: 'POST' });
    setItems((prev) => prev.map((item) => item.id === itemId ? { ...item, vote_count: item.vote_count + 1 } : item));
  };

  const handleAddAction = async () => {
    if (!newActionTitle.trim() || !projectId) return;
    setAddingAction(true);
    try {
      const res = await fetch(`/api/retro-sessions/${id}/actions?project_id=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newActionTitle.trim() }),
      });
      if (res.ok) {
        const j = await res.json();
        setActions((prev) => [...prev, j.data as RetroAction]);
        setNewActionTitle('');
      }
    } finally {
      setAddingAction(false);
    }
  };

  const handleAdvancePhase = async () => {
    if (!session || !projectId) return;
    const next = NEXT_PHASE[session.phase];
    if (!next) return;
    setAdvancingPhase(true);
    try {
      const res = await fetch(`/api/retro-sessions/${id}?project_id=${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: next }),
      });
      if (res.ok) {
        const j = await res.json();
        setSession(j.data as RetroSession);
      }
    } finally {
      setAdvancingPhase(false);
    }
  };

  const handleExport = async () => {
    if (!projectId) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/retro-sessions/${id}/export?project_id=${projectId}`);
      if (res.ok) {
        const j = await res.json();
        setExportMd((j.data as { markdown: string }).markdown);
      }
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
  }

  if (!session) {
    return (
      <div className="p-6">
        <button type="button" onClick={() => router.back()} className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t('backToList')}
        </button>
        <p className="text-sm text-muted-foreground">{t('sessionNotFound')}</p>
      </div>
    );
  }

  const nextPhase = NEXT_PHASE[session.phase];

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => router.push('/retro')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
            <span className="hidden lg:inline">{t('backToList')}</span>
          </button>
          <div>
            <h1 className="text-lg font-semibold text-foreground">{session.title}</h1>
            <Badge variant={PHASE_VARIANTS[session.phase] ?? 'outline'} className="mt-1">
              {t(`phase${session.phase.charAt(0).toUpperCase()}${session.phase.slice(1)}` as 'phaseCollect')}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {nextPhase ? (
            <Button size="sm" onClick={() => void handleAdvancePhase()} disabled={advancingPhase}>
              <ChevronRight className="size-4" />
              {advancingPhase ? '...' : t('phaseNext')}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void handleExport()} disabled={exporting}>
            <Download className="size-4" />
            {exporting ? '...' : t('export')}
          </Button>
        </div>
      </div>

      {/* Export output */}
      {exportMd ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <pre className="whitespace-pre-wrap text-xs text-foreground">{exportMd}</pre>
        </div>
      ) : null}

      {/* Items by category */}
      <div className="grid gap-4 lg:grid-cols-3">
        {CATEGORIES.map((cat) => (
          <div key={cat} className="rounded-lg border border-border bg-card p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              {cat === 'good' ? '👍' : cat === 'bad' ? '👎' : '💡'} {t(`category${cat.charAt(0).toUpperCase()}${cat.slice(1)}` as 'categoryGood')}
            </h2>
            <ul className="space-y-2">
              {items.filter((item) => item.category === cat).map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="text-foreground">{item.text}</span>
                  <button
                    type="button"
                    onClick={() => void handleVote(item.id)}
                    className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                  >
                    <ThumbsUp className="size-3" />
                    {item.vote_count}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Add item */}
      {session.phase !== 'closed' ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">{t('addItem')}</h2>
          <div className="flex flex-col gap-2 lg:flex-row">
            <select
              value={newItemCategory}
              onChange={(e) => setNewItemCategory(e.target.value as 'good' | 'bad' | 'improve')}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat === 'good' ? '👍' : cat === 'bad' ? '👎' : '💡'} {t(`category${cat.charAt(0).toUpperCase()}${cat.slice(1)}` as 'categoryGood')}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newItemText}
              onChange={(e) => setNewItemText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddItem(); }}
              placeholder={t('itemPlaceholder')}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <Button size="sm" onClick={() => void handleAddItem()} disabled={addingItem || !newItemText.trim()}>
              <Plus className="size-4" />
              {addingItem ? '...' : t('submit')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Action items */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">{t('actions')}</h2>
        {actions.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t('noActions')}</p>
        ) : (
          <ul className="space-y-2">
            {actions.map((action) => (
              <li key={action.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-foreground">{action.title}</span>
                <Badge variant="outline">{action.status}</Badge>
              </li>
            ))}
          </ul>
        )}
        {session.phase !== 'closed' ? (
          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={newActionTitle}
              onChange={(e) => setNewActionTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleAddAction(); }}
              placeholder={t('actionPlaceholder')}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <Button size="sm" onClick={() => void handleAddAction()} disabled={addingAction || !newActionTitle.trim()}>
              <Plus className="size-4" />
              {addingAction ? '...' : t('addAction')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
