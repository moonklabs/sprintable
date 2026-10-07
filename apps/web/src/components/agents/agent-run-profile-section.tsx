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
import { Switch } from '@/components/ui/switch';
import { fetchWithAuth } from '@/lib/db/client';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useOrgRemoteControl } from '@/lib/org-remote-control';
import { formatOwners } from '@/components/desktop/remote-off';
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
  // story #4598 (Yuna ① · the remote-control card's `ownerOnlyOn/Off` form): the «not an owner» line names the owners — the same
  // reading of the org the /desktop card uses (owner_names come with it · one read per org while shown)
  const tOff = useTranslations('remoteControlOff');
  const { orgId } = useDashboardContext();
  const [orgRemote] = useOrgRemoteControl(orgId);
  const [options, setOptions] = useState<RunProfileOptions | null>(null);
  const [profile, setProfile] = useState<RunProfile | null>(null);
  const [draft, setDraft] = useState<RunProfileDraft | null>(null);
  // story #4598 — «묻지 않고 일하기»: its own draft beside the fields' (the fields are shared with the bulk dialog, this switch is not)
  const [unattendedDraft, setUnattendedDraft] = useState(false);
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
    setUnattendedDraft(data.unattended === true);
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
        // story #4598 — the switch rides with the fields; only an owner's body carries it (anyone else: absent = as it is, so a
        // model · effort save by an admin is never refused for a switch they could not touch)
        body: JSON.stringify({
          runtime: body.runtime, model: body.model, effort: body.effort,
          ...(unattendedSwitchShown ? { unattended: unattendedDraft } : {}),
        }),
      });
      if (res.ok) {
        const data = ((await res.json()) as { data: RunProfile }).data;
        setProfile(data);
        setDraft(initialDraft(options, data));
        setUnattendedDraft(data.unattended === true);
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

  // story #4598 (PO 11:37Z · Yuna ①-Codex): the switch is a Claude Code agent's — a Codex agent shows the fact line only, owner or not
  // (nothing is said to be «owners only» when nobody can turn it on). The body carries the switch only where it is drawn.
  const unattendedSwitchShown = profile.runtime === 'claude-code' && profile.can_change_unattended === true;
  const unchanged = JSON.stringify(draftBody(draft)) === JSON.stringify(draftBody(initialDraft(options, profile)))
    && (!unattendedSwitchShown || unattendedDraft === (profile.unattended === true));
  const owners = formatOwners(orgRemote?.owner_names ?? [], (first, n) => tOff('ownersMore', { first, n }));
  const ownerNames = { owners, hasOwners: owners ? 'yes' : 'no' };

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
        {/* story #4598 (Yuna 정본 `yuna/4598-unattended-copy.md` ①) — «묻지 않고 일하기»: one row of the group. An owner of a Claude Code
            agent gets the switch + the one-line why (saved with [저장] like model · effort — used from the next start). Anyone else sees
            no switch but a visible line — «… · 켜짐/꺼짐 — 조직 소유자(…)만 켜고 끌 수 있어요» (the rule: a disabled reason is a visible
            sentence, not a greyed control). A Codex agent gets the fact line only, owner or not (PO 11:37Z). */}
        <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-start" data-testid="run-profile-unattended">
          {unattendedSwitchShown ? (
            <>
              <span id="run-profile-unattended-label" className="text-sm text-muted-foreground sm:pt-0.5">{ta('runProfileUnattended')}</span>
              <div className="space-y-1">
                <Switch
                  checked={unattendedDraft}
                  disabled={saving}
                  aria-labelledby="run-profile-unattended-label"
                  onCheckedChange={(on) => { setUnattendedDraft(on); setLine(null); }}
                />
                <p className="break-keep text-pretty text-xs text-muted-foreground">{ta('runProfileUnattendedHelp')}</p>
              </div>
            </>
          ) : (
            <p className="break-keep text-pretty text-sm text-muted-foreground sm:col-span-2" data-testid="run-profile-unattended-line">
              {profile.runtime !== 'claude-code'
                ? ta('runProfileUnattendedCodex')
                : profile.unattended === true ? ta('runProfileUnattendedOwnerOnlyOn', ownerNames) : ta('runProfileUnattendedOwnerOnlyOff', ownerNames)}
            </p>
          )}
        </div>
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
