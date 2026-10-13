'use client';
// [SID:4681] (UX-1 · D3 · piece ② · PO 08:1xZ) — the «접근 줄 에이전트» check list of the new-project dialog, on the web and in the app
// alike (AC3): the organization's agents, every box OFF to start (the server keeps no «org-scope» mark — agents.py:68 — so nothing is
// pre-checked), the person checks who may work in the new project; the hook grants each one right after the project is made. The list
// is the same one the workforce screen reads (`/api/team-members?type=agent` · agent-management-tab.tsx:152); inactive agents and the
// «시스템 발행» reserved member (a grant to it is refused by the server · story #3999) are left out.
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';

export interface OrgAgentOption {
  id: string;
  name: string;
  is_active?: boolean;
  runtime_type?: string | null;
}

/** the agents a person may give the new project to: active, not the reserved publisher — in the order the server gives */
export function grantableAgents(list: OrgAgentOption[]): OrgAgentOption[] {
  return list.filter((a) => a.is_active !== false && a.runtime_type !== 'system-publisher');
}

export function ProjectAccessPicker({ selected, onChange, disabled = false, idPrefix }: {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** the dialog's own prefix (two dialogs may mount — sidebar · chip) so input ids never collide */
  idPrefix: string;
}) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
  const [agents, setAgents] = useState<OrgAgentOption[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0); // Yuna §F (non-blocking): [다시 시도] on the failed read — one more read, nothing else

  // the read itself; the «loading» state is set where a read is asked for (the first render · the retry press), not in the effect
  useEffect(() => {
    let alive = true;
    fetchWithAuth('/api/team-members?type=agent')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not ok'))))
      .then((json: { data?: OrgAgentOption[] }) => { if (alive) setAgents(grantableAgents(json.data ?? [])); })
      .catch(() => { if (alive) { setAgents([]); setLoadError(true); } });
    return () => { alive = false; };
  }, [attempt]);

  const toggle = (id: string, on: boolean) => onChange(on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id));

  return (
    <fieldset className="space-y-1" data-testid="project-access-picker" disabled={disabled}>
      <legend className="text-sm font-medium">
        {t('switcherAccessLegend')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
      </legend>
      <p className="text-xs text-muted-foreground">{t('switcherAccessHint')}</p>
      {agents === null ? (
        <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" data-testid="project-access-loading">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span>{tCommon('loading')}</span>
        </div>
      ) : loadError ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive" data-testid="project-access-load-error">
          <span>{t('switcherAccessLoadError')}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { setAgents(null); setLoadError(false); setAttempt((n) => n + 1); }} data-testid="project-access-retry">{tCommon('retry')}</Button>
        </p>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="project-access-empty">{t('switcherAccessEmpty')}</p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-input p-2" data-testid="project-access-list">
          {agents.map((a) => {
            const id = `${idPrefix}-agent-${a.id}`;
            return (
              <li key={a.id} className="flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-brand"
                  checked={selected.includes(a.id)}
                  onChange={(e) => toggle(a.id, e.target.checked)}
                  data-testid="project-access-checkbox"
                  data-agent-id={a.id}
                />
                <label htmlFor={id} className="min-w-0 flex-1 truncate text-sm">{a.name}</label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
