'use client';

/**
 * story #4540 (E-DESKTOP-2 C-5) — «실행» on one agent's settings page (명세 모음 C-5). Shown for desktop runtimes only (the
 * profile is what the desktop app starts the CLI with). Who may change it is the server's `can_change` (the runtime PATCH's
 * rule); everyone else reads it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { EFFORT_LABEL_KEYS, SAVE_ERROR_KEYS, saveErrorKey, type RunProfile, type RunProfileOptions } from '@/lib/agent-run-profile';
import { AgentRunProfileFields, draftBody, draftReady, initialDraft, type RunProfileDraft } from './agent-run-profile-fields';

const RUNTIME_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export async function loadRunProfileOptions(): Promise<RunProfileOptions | null> {
  const res = await fetchWithAuth('/api/agent-run-profile/options');
  if (!res.ok) return null;
  return ((await res.json()) as { data: RunProfileOptions }).data;
}

interface Props {
  agentId: string;
  /** the runtime saved elsewhere on this page changed — read again */
  runtimeType: string | null;
}

export function AgentRunProfileSection({ agentId, runtimeType }: Props) {
  const ta = useTranslations('agents');
  const [options, setOptions] = useState<RunProfileOptions | null>(null);
  const [profile, setProfile] = useState<RunProfile | null>(null);
  const [draft, setDraft] = useState<RunProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState<{ kind: 'saved' | 'error' | 'removed'; key: string; host?: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [opts, res] = await Promise.all([loadRunProfileOptions(), fetchWithAuth(`/api/agents/${agentId}/run-profile`)]);
    if (!opts || !res.ok) {
      setFailed(true);
      return;
    }
    const data = ((await res.json()) as { data: RunProfile }).data;
    setFailed(false);
    setOptions(opts);
    setProfile(data);
    setDraft(initialDraft(opts, data));
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, runtimeType]);

  if (failed) {
    return (
      <SectionCard>
        <SectionCardHeader><h2 className="text-base font-semibold text-foreground">{ta('runProfileTitle')}</h2></SectionCardHeader>
        <SectionCardBody>
          <p className="text-sm text-muted-foreground">{ta('runProfileLoadFailed')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>{ta('runProfileRetry')}</Button>
        </SectionCardBody>
      </SectionCard>
    );
  }
  if (!options || !profile || !draft) return null;

  const save = async () => {
    setSaving(true);
    setLine(null);
    try {
      const body = draftBody(draft);
      const res = await fetchWithAuth(`/api/agents/${agentId}/run-profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: body.runtime, model: body.model, effort: body.effort }),
      });
      if (res.ok) {
        const data = ((await res.json()) as { data: RunProfile }).data;
        setProfile(data);
        setDraft(initialDraft(options, data));
        setLine({ kind: 'saved', key: '' });
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

  const unchanged = JSON.stringify(draftBody(draft)) === JSON.stringify(draftBody(initialDraft(options, profile)));

  // story #4580 (Yuna ④ · 배치 ③): [빼기] — no confirmation (it only narrows), applies at once; the list is read again after it
  const remove = async (host: string) => {
    setRemoving(host);
    setLine(null);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/run-profile/allowed-hosts/${encodeURIComponent(host)}`, { method: 'DELETE' });
      if (res.ok) {
        setProfile((p) => (p ? { ...p, allowed_hosts: (p.allowed_hosts ?? []).filter((h) => h.host !== host) } : p));
        setLine({ kind: 'removed', key: '', host });
      } else {
        const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        setLine({ kind: 'error', key: saveErrorKey(res.status, json?.error?.code) });
      }
    } catch {
      setLine({ kind: 'error', key: SAVE_ERROR_KEYS.other });
    } finally {
      setRemoving(null);
    }
  };
  const hosts = profile.allowed_hosts ?? [];

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{ta('runProfileTitle')}</h2>
          <p className="text-sm text-muted-foreground">{ta('runProfileNextStart')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {profile.can_change ? (
          <>
            <AgentRunProfileFields options={options} draft={draft} onChange={(d) => { setDraft(d); setLine(null); }} disabled={saving} />
            <div className="flex justify-end">
              <Button variant="hero" size="sm" onClick={() => void save()} disabled={saving || unchanged || !draftReady(draft, options)}>
                {saving ? ta('runProfileSaving') : ta('runProfileSave')}
              </Button>
            </div>
          </>
        ) : (
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">{ta('runProfileRuntime')}</dt>
            <dd className="text-foreground">{RUNTIME_LABELS[profile.runtime ?? ''] ?? profile.runtime}</dd>
            <dt className="text-muted-foreground">{ta('runProfileModel')}</dt>
            <dd className="text-foreground">{profile.model ?? ta('runProfileModelDefault')}</dd>
            <dt className="text-muted-foreground">{ta('runProfileEffort')}</dt>
            <dd className="text-foreground">
              {profile.effort ? <>{ta(EFFORT_LABEL_KEYS[profile.effort] ?? 'runProfileEffortDefault')} <code className="text-xs text-muted-foreground">{profile.effort}</code></> : ta('runProfileEffortDefault')}
            </dd>
          </dl>
        )}
        {/* story #4580 (배치 ③): «허용 주소» — one more row of the group; [빼기] only for whoever may change it */}
        <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]" data-testid="run-profile-allowed-hosts">
          <dt className="text-muted-foreground">{ta('runProfileAllowedHosts')}</dt>
          <dd className="space-y-1">
            {hosts.length === 0 ? (
              <p className="text-muted-foreground">{ta('runProfileAllowedHostsEmpty')}</p>
            ) : (
              <ul className="space-y-1">
                {hosts.map((h) => (
                  <li key={h.host} className="flex items-center justify-between gap-2">
                    <span className="break-keep text-sm font-medium text-foreground [overflow-wrap:anywhere]">{h.host}</span>
                    {profile.can_change ? (
                      <Button variant="ghost" size="sm" onClick={() => void remove(h.host)} disabled={removing !== null}
                        aria-label={`${ta('runProfileAllowedHostRemove')} · ${h.host}`}>
                        {ta('runProfileAllowedHostRemove')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="break-keep text-pretty text-xs text-muted-foreground">{ta('runProfileAllowedHostsHelp')}</p>
            {/* Yuna 4972 ①: only where something can be removed (a list · a person who may change it) */}
            {hosts.length > 0 && profile.can_change ? <p className="break-keep text-pretty text-xs text-muted-foreground">{ta('runProfileAllowedHostsNow')}</p> : null}
          </dd>
        </dl>
        {line ? (
          <p role="status" className={line.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {line.kind === 'saved' ? ta('runProfileSavedLine') : line.kind === 'removed' ? ta('runProfileAllowedHostRemoved', { host: line.host ?? '' }) : ta(line.key)}
          </p>
        ) : null}
      </SectionCardBody>
    </SectionCard>
  );
}
