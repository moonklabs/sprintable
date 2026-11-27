'use client';

/**
 * story 5041 ② (web) — «에이전트가 혼자 해도 되는 일» on one agent's settings page: for ONE agent in ONE project, what it may do on its own — «늘 허용» (it does it, on its own rights) · «물어봄» (an approval card
 * goes to a person) · «막음». The product decides only the defaults; everything here is the user's setting. The server owns every rule — which actions can be allowed for good, which are a person's own signature
 * (locked), where a level comes from — this section only draws what it says. Shown to organisation owners / admins only (the page's own gate; the server answers 403 to anyone else, and then nothing is drawn).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { NativeSelect } from '@/components/ds/select';
import { DetailCard } from '@/components/agents/detail-card';
import { clearPolicy, fetchPolicy, setPolicy, type PolicyEntry, type PolicyLevel, type PolicySource } from '@/lib/agent-action-policy';

interface ProjectOption {
  id: string;
  name: string;
}

const LEVELS: readonly PolicyLevel[] = ['auto', 'ask', 'block'];
type T = ReturnType<typeof useTranslations>;

// literal keys on purpose (the dead-key guard reads the code, not a table)
function sourceLabel(t: T, source: PolicySource): string {
  switch (source) {
    case 'org': return t('actionPolicySourceOrg');
    case 'org_agent': return t('actionPolicySourceOrgAgent');
    case 'project': return t('actionPolicySourceProject');
    case 'project_agent': return t('actionPolicySourceProjectAgent');
    case 'floor': return t('actionPolicySourceFloor');
    default: return t('actionPolicySourceDefault');
  }
}
function levelLabel(t: T, level: PolicyLevel): string {
  return level === 'auto' ? t('actionPolicyLevelAuto') : level === 'ask' ? t('actionPolicyLevelAsk') : t('actionPolicyLevelBlock');
}

export function AgentActionPolicySection({ agentId, projects }: { agentId: string; projects: ProjectOption[] }) {
  const t = useTranslations('agents');
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [entries, setEntries] = useState<PolicyEntry[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'forbidden' | 'fault'>('loading');
  const [saving, setSaving] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  // the newest read wins: an answer for a project that is no longer the one shown (a slow one that arrives after another was chosen) is dropped, never drawn under the wrong project (codex on this PR)
  const readSeq = useRef(0);
  // the answer is drawn only if it is still the newest ask; the effect asks through `.then` (a callback — not a synchronous setState in the effect body, which the lint rule refuses), «loading» is set by the handlers that ask again (project chosen · retry) and is the initial state
  const apply = useCallback((mine: number, r: Awaited<ReturnType<typeof fetchPolicy>>) => {
    if (mine !== readSeq.current) return;
    if (r.result === 'ok') { setEntries(r.entries); setState('ready'); } else setState(r.result);
  }, []);
  const load = useCallback(async () => {
    if (!projectId) return;
    const mine = ++readSeq.current;
    apply(mine, await fetchPolicy(agentId, projectId));
  }, [agentId, projectId, apply]);
  useEffect(() => {
    if (!projectId) return;
    const mine = ++readSeq.current;
    void fetchPolicy(agentId, projectId).then((r) => apply(mine, r));
  }, [agentId, projectId, apply]);

  const label = (key: string) => {
    const k = `actionPolicyAction_${key.replace(/\./g, '_')}`;
    return t.has(k) ? t(k) : key;
  };
  const change = async (entry: PolicyEntry, level: PolicyLevel) => {
    if (saving || entry.locked || level === entry.level) return;
    setSaving(entry.actionKey); setSaveFailed(false);
    const ok = await setPolicy(agentId, projectId, entry.actionKey, level);
    if (!ok) { setSaving(null); setSaveFailed(true); return; }
    await load(); // the next press waits for this read: `saving` stays up until it is back, and the project cannot be switched meanwhile
    setSaving(null);
  };
  const reset = async (entry: PolicyEntry) => {
    if (saving) return;
    setSaving(entry.actionKey); setSaveFailed(false);
    const ok = await clearPolicy(agentId, projectId, entry.actionKey);
    if (!ok) { setSaving(null); setSaveFailed(true); return; }
    await load();
    setSaving(null);
  };

  if (!projects.length || state === 'forbidden') return null;
  const adjustable = (entries ?? []).filter((e) => !e.locked);
  const locked = (entries ?? []).filter((e) => e.locked);

  return (
    <DetailCard data-testid="agent-detail-card-action-policy" title={t('actionPolicyTitle')}>
      <p className="m-0 text-ds-small text-ds-ink-3">{t('actionPolicyHint')}</p>
      <label className="flex items-center gap-2 text-ds-small text-ds-ink-2">
        <span>{t('actionPolicyProject')}</span>
        <NativeSelect value={projectId} disabled={saving !== null} onChange={(e) => { setState('loading'); setProjectId(e.target.value); }} data-testid="action-policy-project">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </label>
      {state === 'fault' ? (
        <div className="flex flex-col items-start gap-2">
          <p className="m-0 text-ds-body text-ds-ink-3">{t('actionPolicyLoadFailed')}</p>
          <Button variant="secondary" onClick={() => { setState('loading'); void load(); }}>{t('actionPolicyRetry')}</Button>
        </div>
      ) : null}
      {state === 'ready' ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="action-policy-rows">
          {adjustable.map((e) => (
            <li key={e.actionKey} className="flex min-w-0 flex-col gap-1 border-b border-ds-line pb-2" data-testid={`action-policy-row-${e.actionKey}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-ds-body text-ds-ink">{label(e.actionKey)}</span>
                <Chip>{sourceLabel(t, e.source)}</Chip>
              </div>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label(e.actionKey)}>
                {LEVELS.map((level) => (
                  <Button
                    key={level}
                    variant={e.level === level ? 'primary' : 'secondary'}
                    aria-pressed={e.level === level}
                    aria-label={`${label(e.actionKey)} · ${levelLabel(t, level)}`}
                    disabled={saving !== null || (level === 'auto' && !e.autoAllowed)}
                    onClick={() => void change(e, level)}
                  >
                    {levelLabel(t, level)}
                  </Button>
                ))}
                {e.source === 'project_agent' ? <Button variant="quiet" aria-label={`${label(e.actionKey)} · ${t('actionPolicyReset')}`} disabled={saving !== null} onClick={() => void reset(e)}>{t('actionPolicyReset')}</Button> : null}
              </div>
              {!e.autoAllowed ? <p className="m-0 text-ds-small text-ds-ink-3">{t('actionPolicyNoAuto')}</p> : null}
              {e.level === 'auto' ? <p className="m-0 text-ds-small text-ds-ink-3">{t('actionPolicyAutoWarn')}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {saveFailed ? <p role="alert" className="m-0 text-ds-small text-ds-failed">{t('actionPolicySaveFailed')}</p> : null}
      {state === 'ready' && locked.length ? (
        <div className="flex flex-col gap-1" data-testid="action-policy-locked">
          <p className="m-0 text-ds-small font-medium text-ds-ink-2">{t('actionPolicyLockedTitle')}</p>
          <p className="m-0 text-ds-small text-ds-ink-3">{t('actionPolicyLockedHint')}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {locked.map((e) => (
              <li key={e.actionKey} className="flex min-w-0 items-center gap-2 text-ds-small text-ds-ink-3">
                <Chip>{sourceLabel(t, 'floor')}</Chip>
                <span className="min-w-0 break-words">{label(e.actionKey)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </DetailCard>
  );
}
