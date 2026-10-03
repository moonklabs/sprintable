'use client';

/**
 * story #4540 (E-DESKTOP-2 C-5 · AC3) — the same «실행» group for many agents chosen on the list: «에이전트 {n}개에 적용».
 * Every field starts «그대로 두기»; with mixed runtimes, model · effort open only once one runtime is chosen for all. The server
 * takes it all or nothing. After saving there is no restart here — the line points to the desktop app (PO ⓓ).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchWithAuth } from '@/lib/db/client';
import { SAVE_ERROR_KEYS, saveErrorKey, sharedRuntime, type RunProfileOptions } from '@/lib/agent-run-profile';
import { AgentRunProfileFields, draftBody, draftReady, initialDraft, type RunProfileDraft } from './agent-run-profile-fields';
import { loadRunProfileOptions } from './agent-run-profile-section';

interface Props {
  agents: { id: string; runtime_type?: string | null }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function AgentRunProfileBulkDialog({ agents, open, onOpenChange, onSaved }: Props) {
  const ta = useTranslations('agents');
  const tc = useTranslations('common');
  const [options, setOptions] = useState<RunProfileOptions | null>(null);
  const [draft, setDraft] = useState<RunProfileDraft>(initialDraft(null, null));
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState<{ kind: 'saved' | 'error'; key: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // [적용] turns into [닫기] after saving — focus goes to it, not to the page (유나 4943 ②)
  useEffect(() => {
    if (line?.kind === 'saved') closeRef.current?.focus();
  }, [line]);

  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(null, null));
    setLine(null);
    void loadRunProfileOptions().then(setOptions);
  }, [open]);

  const shared = sharedRuntime(agents.map((a) => a.runtime_type));
  const body = draftBody(draft);
  const nothing = body.runtime === 'keep' && body.model === 'keep' && body.effort === 'keep';

  const save = async () => {
    setSaving(true);
    setLine(null);
    try {
      const res = await fetchWithAuth('/api/agents/run-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_ids: agents.map((a) => a.id), ...body }),
      });
      if (res.ok) {
        setLine({ kind: 'saved', key: '' });
        onSaved();
      } else {
        const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        setLine({ kind: 'error', key: saveErrorKey(res.status, json?.error?.code) });
      }
    } catch {
      setLine({ kind: 'error', key: SAVE_ERROR_KEYS.other });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{ta('runProfileBulkTitle')}</DialogTitle>
          <DialogDescription>{ta('runProfileNextStart')}</DialogDescription>
        </DialogHeader>
        {options ? (
          <AgentRunProfileFields
            options={options}
            draft={draft}
            onChange={(d) => { setDraft(d); setLine(null); }}
            keepAllowed
            sharedRuntime={shared}
            disabled={saving || line?.kind === 'saved'}
          />
        ) : null}
        {line ? (
          <p role="status" className={line.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>{line.kind === 'saved' ? ta('runProfileSavedLine') : ta(line.key)}</p>
        ) : null}
        <DialogFooter>
          {line?.kind === 'saved' ? (
            <Button ref={closeRef} variant="hero" onClick={() => onOpenChange(false)}>{tc('close')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{tc('cancel')}</Button>
              <Button
                variant="hero"
                onClick={() => void save()}
                disabled={saving || !options || nothing || !draftReady(draft, options)}
              >
                {saving ? ta('runProfileSaving') : ta('runProfileBulkApply', { count: agents.length })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
