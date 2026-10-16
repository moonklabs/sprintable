'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';
import { isEEEnabled } from '@/lib/ee';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { defaultOrgName } from '@/app/onboarding/desktop-create-org';
import { onboardingRedirect } from '@/lib/auth/onboarding-next';
import { EmailVerifyGateCard, useEmailVerifyGate } from '@/components/auth/email-verify-gate';
import { appSetupLink, nativeReturnApp, RETURN_APP_PARAM } from '@/lib/auth/native-return-app';
import { useSearchParams } from 'next/navigation';
import { setupFragment, isFolderRefused, type DesktopRuntime, type SetupQuery } from '@/lib/desktop-setup';
import { defaultSoloRuntime, shownProjectName, soloConfirmBody, soloNewOrgConfirmBody, soloOutcome, soloStartBlock, usableRuntimes } from '@/lib/desktop-setup-quick';
import { Failure, INSTALL, InvitedCard, RUNTIME_LABEL, SetupDoneReload, TooOldCard, joinNewOrg, limitCounts, useAppSetupLinks, type MyInvite } from './desktop-setup';
import { SetupProgressView } from './desktop-setup-progress';

/**
 * story 4711 — the first setup in three steps (Yuna `yuna/4711-copy-1016.md`): ① the agent found on this computer · ② a folder from the
 * Mac's own folder window (the APP opens it — a page cannot; the answer comes back in the address's `#`) · ③ [시작]. One card, all three
 * steps in view; the recipe setup is one text link away (`onTeam`). The server gets the runtime and the folder's NAME (or the project the
 * app found for the folder) — never a path. No recipe, no first task: the first screen after the start is the conversation (the progress
 * view opens it).
 */
type OrgMode = { kind: 'has-org' } | { kind: 'checking' } | { kind: 'new' } | { kind: 'invited'; invites: MyInvite[] };
type View = { kind: 'choose' } | { kind: 'starting' } | { kind: 'started' } | { kind: 'done-reload' }
  | { kind: 'failed'; failure: 'offline' | 'not-admin' | 'expired' | 'has-org' | 'agent-limit'; counts?: { need: number; left: number } | null };

export function DesktopSetupQuick({ query, onTeam }: { query: SetupQuery; onTeam: () => void }) {
  const t = useTranslations('desktop.setup');
  const tNewOrg = useTranslations('desktopOnboarding');
  const tOnboarding = useTranslations('onboarding');
  const tNav = useTranslations('nav');
  const flatHref = useFlatHref();
  const links = useAppSetupLinks();
  const app = nativeReturnApp(useSearchParams()?.get(RETURN_APP_PARAM));
  const { projectId, userName, orgId, orgMemberships, projectMemberships } = useDashboardContext();
  const [orgMode, setOrgMode] = useState<OrgMode>(() => (orgId ? { kind: 'has-org' } : { kind: 'checking' }));
  const newOrg = orgMode.kind === 'new';
  const orgRole = orgMemberships?.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = orgRole === 'owner' || orgRole === 'admin';
  const orgProjects = useMemo(() => (projectMemberships ?? []).filter((m) => !m.orgId || m.orgId === orgId), [projectMemberships, orgId]);
  const verifyGate = useEmailVerifyGate(newOrg, () => { setOrgMode({ kind: 'checking' }); void readInvites(); });
  const [orgName, setOrgName] = useState('');
  const [view, setView] = useState<View>({ kind: 'choose' });
  const [rateLine, setRateLine] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [pickedRuntime, setPickedRuntime] = useState<DesktopRuntime | null>(null);
  const [wideOk, setWideOk] = useState(false);
  /** the one project of a free organization that the 402 named; chosen by [넣고 시작] only */
  const [limitAsk, setLimitAsk] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState<DesktopRuntime | null>(null);

  async function readInvites() {
    try {
      const res = await fetchWithAuth('/api/invites/mine');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const list: unknown = body?.invites ?? body?.data?.invites;
      if (!Array.isArray(list)) throw new Error('no list');
      setOrgMode(list.length ? { kind: 'invited', invites: list as MyInvite[] } : { kind: 'new' });
    } catch {
      window.location.assign(onboardingRedirect(window.location.pathname));
    }
  }
  useEffect(() => { if (!orgId) void readInvites(); }, [orgId]);
  useEffect(() => {
    if (!newOrg) return;
    let off = false;
    const fallback = tNewOrg('defaultOrgName');
    setOrgName((n) => n || fallback);
    fetchWithAuth('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { display_name?: string | null } } | null) => {
        if (!off) setOrgName(defaultOrgName(json?.data?.display_name ?? userName ?? null, (n) => tNewOrg('defaultOrgNameWithName', { name: n }), fallback));
      })
      .catch(() => { /* keep «내 조직» */ });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOrg]);

  const usable = usableRuntimes(query);
  const runtime = pickedRuntime && usable.includes(pickedRuntime) ? pickedRuntime : defaultSoloRuntime(usable, query.pick);
  const folder = query.folder && !isFolderRefused(query.folder) ? query.folder : undefined;
  const refused = isFolderRefused(query.folder) ? query.folder.refused : null;
  // the project the app found for this folder counts only if this organization really has it — else it is a new project by the folder's name
  const matched = folder?.projectId && !newOrg ? orgProjects.find((p) => p.projectId === folder.projectId) : undefined;
  const projectLine = !folder ? null
    : limitAsk ? { kind: 'chosen' as const, name: limitAsk.name }
    : matched ? { kind: 'existing' as const, name: matched.projectName }
    : { kind: 'new' as const, name: newOrg ? folder.name : shownProjectName(folder.name, orgProjects.map((p) => p.projectName)) };
  const block = soloStartBlock(runtime, folder, wideOk);
  const folderLink = appSetupLink(app, 'folder', { pick: runtime });

  async function start(useProject?: string) {
    if (!runtime || !folder || soloStartBlock(runtime, folder, wideOk)) return;
    setRateLine(null);
    setErrorLine(null);
    setView({ kind: 'starting' });
    const post = (path: string, body: unknown) => fetchWithAuth(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const res = newOrg
        ? await post('/api/desktop/setup-codes/confirm-solo-new-org', soloNewOrgConfirmBody(query.code, runtime, folder, orgName))
        : await post('/api/desktop/setup-codes/confirm-solo', soloConfirmBody(query.code, runtime, matched ? folder : { ...folder, projectId: undefined }, useProject));
      if (res.ok) {
        const okBody = await res.json().catch(() => null) as { project_id?: string; org_id?: string } | null;
        // the tab has no project (or no organization) yet: the one made (or used) becomes the tab's, the way the recipe setup does
        if ((newOrg || !projectId) && !(await joinNewOrg(newOrg ? okBody : { project_id: okBody?.project_id ?? useProject ?? matched?.projectId }))) { setView({ kind: 'done-reload' }); return; }
        setView({ kind: 'started' });
        return;
      }
      const body = await res.json().catch(() => null);
      const error = body?.error as { code?: string; resource?: string; limit?: unknown } | undefined;
      const out = soloOutcome(res.status, error, res.headers.get('Retry-After'));
      switch (out.kind) {
        case 'rate-limited': {
          const secs = out.retryAfter;
          const time = secs === null ? t('rateLimitedMoment') : secs < 60 ? t('rateLimitedSeconds', { n: Math.ceil(secs) }) : t('rateLimitedMinutes', { n: Math.ceil(secs / 60) });
          setRateLine(t('rateLimited', { time }));
          setView({ kind: 'choose' });
          return;
        }
        case 'use-existing-project': setLimitAsk(out.project); setView({ kind: 'choose' }); return;
        case 'project-limit': setErrorLine(t('firstProject.limit', { limit: typeof error?.limit === 'number' ? error.limit : 1 })); setView({ kind: 'choose' }); return;
        case 'agent-limit': setView({ kind: 'failed', failure: 'agent-limit', counts: limitCounts(body?.error) }); return;
        case 'not-admin': setView({ kind: 'failed', failure: 'not-admin' }); return;
        case 'expired': setView({ kind: 'failed', failure: 'expired' }); return;
        case 'has-org': setView({ kind: 'failed', failure: 'has-org' }); return;
        case 'pending-invites': await readInvites(); setView({ kind: 'choose' }); return;
        case 'email-verify': setErrorLine(tOnboarding('emailVerifyRequiredError')); setView({ kind: 'choose' }); return;
        default: setErrorLine(t('quick.failed')); setView({ kind: 'choose' });
      }
    } catch {
      setView({ kind: 'failed', failure: 'offline' });
    }
  }

  if (orgMode.kind === 'invited') return <InvitedCard invites={orgMode.invites} />;
  if (newOrg && verifyGate.kind === 'closed') return <EmailVerifyGateCard gate={verifyGate} />;
  if (orgMode.kind === 'checking' || (newOrg && verifyGate.kind === 'reading')) return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (orgMode.kind === 'has-org' && !isAdmin) return <Failure failure="not-admin" />;
  if (view.kind === 'done-reload') return <SetupDoneReload setupId={query.setupId} />;
  if (view.kind === 'started') return <SetupProgressView setupId={query.setupId} recipeName="" />;
  if (view.kind === 'failed') {
    const onReloadPage = view.failure === 'has-org'
      ? () => { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + setupFragment(query)); window.location.reload(); }
      : undefined;
    return <Failure failure={view.failure} counts={view.counts ?? null} onRetry={view.failure === 'offline' ? () => void start(limitAsk?.id) : undefined} onReloadPage={onReloadPage} />;
  }
  // nothing usable on this computer: blocked by the company's policy · installed but too old · not found (the install lines)
  if (usable.length === 0) {
    if (query.blocked.length > 0) return <Failure failure="managed" />;
    if ((query.old?.length ?? 0) > 0) return <TooOldCard old={query.old ?? []} />;
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="quick-no-agent">
        <h1 className="text-lg font-semibold">{t('quick.noAgentTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('quick.noAgentBody')}</p>
        <ul className="flex flex-col gap-2">
          {(Object.keys(INSTALL) as DesktopRuntime[]).map((r) => (
            <li key={r} className="flex items-center justify-between gap-3 rounded-md border p-2">
              <span className="shrink-0 text-sm font-medium">{RUNTIME_LABEL[r]}</span>
              <code className="min-w-0 flex-1 truncate text-xs">{INSTALL[r]}</code>
              <Button variant="ghost" size="sm" aria-label={t('quick.copyAria', { name: RUNTIME_LABEL[r] })}
                onClick={() => { void navigator.clipboard?.writeText(INSTALL[r]).catch(() => {}); setCopied(r); }}>
                {copied === r ? t('quick.copied') : t('quick.copy')}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2"><Button asChild><a href={links.open}>{t('quick.refind')}</a></Button></div>
      </Card>
    );
  }

  const name = runtime ? RUNTIME_LABEL[runtime] : '';
  const starting = view.kind === 'starting';
  const blockLine = block === 'no-agent' ? t('quick.blockNoAgent') : block === 'no-folder' ? t('quick.blockNoFolder') : block === 'wide-unconfirmed' ? t('quick.blockWide') : null;
  const withVersion = (r: DesktopRuntime) => query.versions?.[r];
  return (
    <div className="flex flex-col gap-3">
      <Card className="break-keep flex flex-col gap-5 p-6" data-testid="quick-card">
        <h1 className="text-lg font-semibold">{t('quick.title')}</h1>

        <section aria-labelledby="quick-step-agent" className="flex flex-col gap-2">
          <h2 id="quick-step-agent" className="text-sm font-medium">① {t('quick.stepAgent')}</h2>
          {usable.length > 1 ? (
            <div role="radiogroup" aria-labelledby="quick-step-agent" className="flex flex-col gap-1">
              {usable.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="quick-runtime" checked={runtime === r} onChange={() => setPickedRuntime(r)} />
                  <span>{RUNTIME_LABEL[r]}</span>
                  {withVersion(r) ? <span className="text-xs text-muted-foreground">{withVersion(r)}</span> : null}
                </label>
              ))}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm"><span>{runtime ? RUNTIME_LABEL[runtime] : ''}</span>{runtime && withVersion(runtime) ? <span className="text-xs text-muted-foreground">{withVersion(runtime)}</span> : null}</p>
          )}
          {(query.old ?? []).map((o) => (
            <p key={o.runtime} className="text-xs text-muted-foreground">{t('quick.tooOld', { name: RUNTIME_LABEL[o.runtime], version: o.version })}</p>
          ))}
        </section>

        <section aria-labelledby="quick-step-folder" className="flex flex-col gap-2">
          <h2 id="quick-step-folder" className="text-sm font-medium">② {t('quick.stepFolder')}</h2>
          {refused ? (
            <p role="alert" className="text-sm text-destructive" data-testid="quick-refused">
              {refused === 'denied' ? t('quick.refused.denied')
                : refused === 'app_folder' ? t('quick.refused.app_folder')
                  : refused === 'not_folder' ? t('quick.refused.not_folder')
                    : t('quick.refused.missing')}
            </p>
          ) : null}
          {folder ? (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <code className="min-w-0 truncate text-xs" data-testid="quick-folder">{folder.shown}</code>
                <Button asChild variant="ghost" size="sm"><a href={folderLink}>{t('quick.folderChange')}</a></Button>
              </p>
              {projectLine ? (
                <p className="text-sm text-muted-foreground" data-testid="quick-project">
                  {projectLine.kind === 'new' ? t('quick.projectNew', { name: projectLine.name })
                    : projectLine.kind === 'existing' ? t('quick.projectExisting', { name: projectLine.name })
                      : t('quick.projectChosen', { name: projectLine.name })}
                </p>
              ) : null}
              {folder.wide && !wideOk ? (
                <div role="status" className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="quick-wide">
                  <p>{t('quick.wideAsk')}</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setWideOk(true)}>{t('quick.wideYes')}</Button>
                    <Button asChild size="sm" variant="outline"><a href={folderLink}>{t('quick.folderOther')}</a></Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            runtime ? <div><Button asChild variant="outline"><a href={folderLink}>{t('quick.folderPick')}</a></Button></div> : null
          )}
        </section>

        {limitAsk ? (
          <div role="status" className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="quick-limit">
            <p className="font-medium">{t('quick.limit.title')}</p>
            <p>{t('quick.limit.body', { project: limitAsk.name })}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={starting} onClick={() => void start(limitAsk.id)}>{starting ? t('quick.starting') : t('quick.limit.addStart')}</Button>
              {isEEEnabled() ? <a className="text-xs underline underline-offset-2" href={flatHref('/settings?tab=billing')}>{tNav('orgLimitUpgradeLink')}</a> : null}
            </div>
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          {errorLine ? <p role="alert" className="text-sm text-destructive" data-testid="quick-error">{errorLine}</p> : null}
          {rateLine ? <p role="alert" className="text-sm text-destructive">{rateLine}</p> : null}
          {/* the free-plan question has its own primary [넣고 시작] — the start row is not drawn beside it (Yuna 5121 ①) */}
          {limitAsk ? null : (
            <div className="flex flex-col gap-2">
              <div><Button disabled={starting || block !== null} aria-describedby="quick-start-line" onClick={() => void start()}>{starting ? t('quick.starting') : t('quick.start')}</Button></div>
              <p id="quick-start-line" className="text-sm text-muted-foreground" data-testid="quick-start-line">
                {blockLine ?? (runtime && projectLine
                  ? t('quick.startLine', { runtime: `${name}`, project: projectLine.name })
                  : '')}
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('toolNote')}</p>
        </section>
      </Card>
      <p className="text-sm"><Button type="button" variant="link" className="h-auto p-0 underline underline-offset-2" onClick={onTeam}>{t('quick.team')}</Button></p>
    </div>
  );
}
