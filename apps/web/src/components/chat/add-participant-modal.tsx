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

interface AddParticipantModalProps {
  conversationId: string;
  conversationType: 'dm' | 'group';
  projectId: string;
  existingParticipantIds: string[];
  onClose: () => void;
  onAdded: (newConversationId?: string) => void;
}

export function AddParticipantModal({
  conversationId,
  conversationType,
  projectId,
  existingParticipantIds,
  onClose,
  onAdded,
}: AddParticipantModalProps) {
  const t = useTranslations('chats');
  const tc = useTranslations('common');
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/team-members?is_active=true&project_id=${projectId}`)
      .then((r) => r.json())
      .then((json) => setMembers((json.data ?? []) as Member[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const available = members.filter((m) => !existingParticipantIds.includes(m.id));

  const handleAdd = async () => {
    if (!selected || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: selected }),
      });
      if (!res.ok) throw new Error('Failed to add participant');
      const data = await res.json() as { conversation_id?: string; forked?: boolean };
      onAdded(data.conversation_id);
    } catch {
      setError('참여자 추가에 실패했습니다. 다시 시도해보세요.');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-xl border border-border bg-popover shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('addParticipantsTitle')}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {conversationType === 'dm' && (
            <p className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t('forkInfo')}
            </p>
          )}
          <p className="mb-2 text-xs text-muted-foreground">{t('selectMembers')}</p>
          {loading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">불러오는 중…</div>
          ) : available.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">추가 가능한 팀원이 없는</div>
          ) : (
            <ul className="space-y-1">
              {available.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => setSelected((prev) => (prev === m.id ? null : m.id))}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                      selected === m.id
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
                    {selected === m.id && <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={adding}>
            {tc('cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleAdd()} disabled={!selected || adding}>
            {adding ? t('adding') : t('addParticipants')}
          </Button>
        </div>
      </div>
    </div>
  );
}
