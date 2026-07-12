'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { resolveRecipientPrefill } from '@/lib/epic-steer';

interface AgentMember {
  id: string;
  name: string;
}

interface CuratedItem {
  id: string;
  position: number;
}

interface SteerDispatchModalProps {
  projectId: string;
  /** 커밋할 순서 스냅샷 = 큐레이션된 에픽(position≠null)의 {id, position}. */
  items: CuratedItem[];
  onClose: () => void;
  /** 커밋 성공 시 지정 수신자 이름 목록을 상위로(핸드오프 compact 표시용). */
  onDispatched: (recipientNames: string[]) => void;
}

/** 프리필 = 프로젝트별 마지막 선택 기억(일반적·org-agnostic·하드코딩/오르테가 고정 금지). */
function lastRecipientsKey(projectId: string): string {
  return `steer-recipients:${projectId}`;
}

function readRemembered(projectId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(lastRecipientsKey(projectId)) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as string[]).filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * STEER v2 조타 커밋 모달(story 2628a53b). 드래그는 조용한 초안, 이 "보내기"에서만 지정 수신자에게
 * 커밋을 전달한다(POST /api/epics/steer-dispatch → epic.reordered 1회). 수신자는 프로젝트 에이전트
 * 중 인간이 명시(필수). BE엔 기본 수신자가 없으므로(보편 orchestrator 가정 금지) 프리필은 순전히
 * FE 편의 = 마지막 선택 기억. 409(스냅샷 conflict)는 재확認 안내로 구분 처리.
 */
export function SteerDispatchModal({ projectId, items, onClose, onDispatched }: SteerDispatchModalProps) {
  const t = useTranslations('epics');
  const [agents, setAgents] = useState<AgentMember[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/team-members');
        if (!res.ok) throw new Error(`team-members ${res.status}`);
        const { data } = await res.json() as {
          data: Array<{ id: string; name: string; type: string; is_active: boolean }>;
        };
        const list = (data ?? [])
          .filter((m) => m.type === 'agent' && m.is_active)
          .map((m) => ({ id: m.id, name: m.name }));
        if (!alive) return;
        setAgents(list);
        // 프리필 = 마지막 선택 ∩ 현재 가용(사라진 멤버는 자동 탈락·하드코딩 없음).
        setSelected(new Set(resolveRecipientPrefill(readRemembered(projectId), list.map((a) => a.id))));
      } catch (err) {
        console.error('[steer] 프로젝트 멤버 로드 실패', err);
        if (alive) setAgents([]);
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  }, []);

  const handleSend = useCallback(async () => {
    if (selected.size === 0) { setError(t('steerRecipientRequired')); return; } // 클라 사전검증(BE 400 前)
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/epics/steer-dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, recipient_member_ids: [...selected] }),
      });
      if (res.status === 409) { setError(t('steerDispatchConflict')); setSending(false); return; }
      if (!res.ok) { setError(t('steerDispatchError')); setSending(false); return; }
      try { localStorage.setItem(lastRecipientsKey(projectId), JSON.stringify([...selected])); } catch { /* localStorage 불가 무시 */ }
      const names = (agents ?? []).filter((a) => selected.has(a.id)).map((a) => a.name);
      onDispatched(names);
    } catch (err) {
      console.error('[steer] 조타 디스패치 실패', err);
      setError(t('steerDispatchError'));
      setSending(false);
    }
  }, [selected, items, projectId, agents, onDispatched, t]);

  const noAgents = (agents?.length ?? 0) === 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('steerCommitTitle')}</DialogTitle>
          <DialogDescription>{t('steerCommitDesc')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-64 overflow-y-auto py-1">
          {agents === null ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('loading')}</p>
          ) : agents.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('steerNoAgents')}</p>
          ) : (
            <ul className="space-y-1">
              {agents.map((a) => {
                const on = selected.has(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => toggle(a.id)}
                      aria-pressed={on}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        on ? 'border-proof-blue/40 bg-proof-blue-soft text-foreground' : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <span className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                        on ? 'border-proof-blue bg-proof-blue text-white' : 'border-border'
                      }`}>
                        {on ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : null}
                      </span>
                      <span className="truncate">{a.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>{t('cancel')}</Button>
          <Button size="sm" onClick={() => void handleSend()} disabled={sending || selected.size === 0 || noAgents}>
            {sending ? '…' : t('steerDispatchSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
