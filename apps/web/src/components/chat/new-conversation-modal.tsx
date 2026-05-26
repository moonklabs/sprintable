'use client';

import { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface Member {
  id: string;
  name: string;
  type: string;
}

interface NewConversationModalProps {
  projectId: string;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}

export function NewConversationModal({ projectId, onClose, onCreated }: NewConversationModalProps) {
  const t = useTranslations('chats');
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/team-members?is_active=true&project_id=${projectId}`)
      .then((r) => r.json())
      .then((json) => setMembers((json.data ?? []) as Member[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const toggle = (id: string) => {
    setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const isDm = selected.length === 1;
  const canCreate = selected.length >= 1;

  const handleCreate = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: isDm ? 'dm' : 'group',
          title: !isDm && groupTitle.trim() ? groupTitle.trim() : null,
          participant_ids: selected,
          project_id: projectId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create conversation');
      const data = await res.json() as { id: string };
      onCreated(data.id);
    } catch {
      setError('대화 생성에 실패했습니다. 다시 시도해보세요.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-backdrop backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-xl border border-border bg-popover shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('newConversation')}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="mb-2 text-xs text-muted-foreground">{t('selectMembers')}</p>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
          ) : (
            <ul className="space-y-1">
              {members.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                      selected.includes(m.id)
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted'
                    }`}
                  >
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {m.name.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.type === 'agent' && (
                      <span className="rounded-sm bg-violet-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">AI</span>
                    )}
                    {selected.includes(m.id) && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Group title (2명+ 선택 시) */}
          {selected.length >= 2 && (
            <div className="mt-3">
              <label className="mb-1 block text-xs text-muted-foreground">{t('groupTitle')}</label>
              <input
                type="text"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                placeholder={t('groupTitlePlaceholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={creating}>
            취소
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate || creating}>
            {creating ? '생성 중…' : t('create')}
          </Button>
        </div>
      </div>
    </div>
  );
}
