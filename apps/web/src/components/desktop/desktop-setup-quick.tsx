'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';
import { isEEEnabled } from '@/lib/ee';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { defaultOrgName } from '@/lib/default-org-name';
import { InviteCheckFailedCard } from './invite-check-failed';
import { EmailVerifyGateCard, useEmailVerifyGate } from '@/components/auth/email-verify-gate';
import { appSetupLink, nativeReturnApp, RETURN_APP_PARAM } from '@/lib/auth/native-return-app';
import { putOrgRemoteControl, useOrgRemoteControl } from '@/lib/org-remote-control';
import { useSearchParams } from 'next/navigation';
import { agentRoomOf, roomShort, setupFragment, isFolderRefused, moveConfirmBody, movableState, type AgentRoom, type AttachableAgent, type DesktopRuntime, type SetupQuery } from '@/lib/desktop-setup';
import { agentLimitOf, type AgentLimit } from '@/lib/agent-limit';
import { pickEuroJosa, pickIGaJosa } from '@/lib/korean-particle'; // 4713: «{file}가 · {runtime}로» — the particle follows the word (the scoped honorific guard forbids a fixed one after a placeholder)
import { AGENT_NAME_MAX, AGENT_ROLE_MAX, defaultSoloRuntime, folderTracePick, readTypedAgent, shownProjectName, soloConfirmBody, soloNewOrgConfirmBody, soloOutcome, soloStartBlock, usableRuntimes, writeTypedAgent } from '@/lib/desktop-setup-quick';
import { ATTACHABLE_READ_LIMIT_MS, DesktopSetup, Failure, INSTALL, InvitedInApp, MovedAgentNote, PROGRESS_FRAGMENT, RoomShortBox, RUNTIME_LABEL, SetupDoneReload, TooOldCard, fetchMyInvites, joinNewOrg, limitCounts, moveFailureForCode, useAppSetupLinks, type MyInvite } from './desktop-setup';
import { SetupProgressView } from './desktop-setup-progress';

/**
 * story 4711 — the first setup in three steps (Yuna `yuna/4711-copy-1016.md`): ① the agent found on this computer · ② a folder from the
 * Mac's own folder window (the APP opens it — a page cannot; the answer comes back in the address's `#`) · ③ [시작]. One card, all three
 * steps in view; the recipe setup is one text link away (`onTeam`).
 * story 4784 (the teacher's walk 10-26: «에이전트를 만들지 않았는데..?»): the card IS the moment an agent is made — «에이전트 만들기»: ① the tool found ·
 * ② the name (the tool's name filled in) and an optional role · ③ the folder · [만들기]; the words say nothing is made before the press. The `agent=`
 * move (an agent the organization already has) keeps «시작» and its ① fixed. The server gets the runtime and the folder's NAME (or the project the
 * app found for the folder) — never a path. No recipe, no first task: the first screen after the start is the conversation (the progress
 * view opens it).
 */
type OrgMode = { kind: 'has-org' } | { kind: 'checking' } | { kind: 'new' } | { kind: 'invited'; invites: MyInvite[] } | { kind: 'invite-failed' };
type View = { kind: 'choose' } | { kind: 'starting' } | { kind: 'started' } | { kind: 'done-reload' }
  | { kind: 'failed'; failure: 'offline' | 'not-admin' | 'expired' | 'has-org' | 'agent-limit'; counts?: { need: number; left: number } | null; plan?: AgentLimit | null };

/** The setup the progress belongs to: the SERVER's id from its answer, else the address's own — each only if it is a uuid (the progress route takes nothing else, and a
 *  code-like string must never be written into the address). None valid → null: the plain «started» card, no polling. */
const SETUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function progressIdOf(fromAnswer: unknown, fromAddress: string | null): string | null {
  if (typeof fromAnswer === 'string' && SETUP_UUID.test(fromAnswer)) return fromAnswer;
  return fromAddress && SETUP_UUID.test(fromAddress) ? fromAddress : null;
}

export function DesktopSetupQuick({ query, onTeam, agent, onNotMovable }: { query: SetupQuery; onTeam: () => void; /** story 4711 (`agent=` branch): the recruiter's agent, already checked movable — the card's ① is that one agent (read-only) and «시작» is the MOVE confirmation, never a new agent */ agent?: AttachableAgent; /** the move could not be confirmed because the agent is no longer movable (left the project …): the wrapper falls to the recipe page with its reasons */ onNotMovable?: () => void }) {
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
  // story 4670 AC1 (PO 10-16 correction — it was dropped from this card by mistake): «폰으로도 에이전트 다루기», ONE tick above «시작» (Yuna §M), on by
  // default, only for the person who can switch the org's remote control and only while it is off (a new organization: its maker is the
  // owner-to-be, so always); a read that FAILED draws it too, unticked; already on → no row. The PUT is sent once, only after the start
  // went through and only if the tick is still on — never otherwise (a start unticked: no PUT).
  const [remoteState, , remoteReadFailed] = useOrgRemoteControl(orgId);
  const [phoneControlPicked, setPhoneControl] = useState<boolean | null>(null);
  const phoneControl = phoneControlPicked ?? !remoteReadFailed;
  const [phoneControlFailed, setPhoneControlFailed] = useState(false);
  const showPhoneControl = newOrg || (orgMode.kind === 'has-org' && (remoteReadFailed || (!!remoteState && remoteState.can_change && !remoteState.enabled)));
  const phoneOrgRef = useRef<string | null>(null);
  async function turnPhoneControlOn(phoneOrg: string | null | undefined) {
    if (!showPhoneControl || !phoneControl || !phoneOrg) return;
    phoneOrgRef.current = phoneOrg;
    const turned = await putOrgRemoteControl(phoneOrg);
    setPhoneControlFailed(!turned.ok);
  }
  /** story 4711 (PO 10-16): [다시 켜기] on the progress card after the switch did not turn on — the same one PUT, again */
  async function retryPhoneControl(): Promise<boolean> {
    if (!phoneOrgRef.current) return false;
    const turned = await putOrgRemoteControl(phoneOrgRef.current);
    setPhoneControlFailed(!turned.ok);
    return turned.ok;
  }
  const verifyGate = useEmailVerifyGate(newOrg, () => { setOrgMode({ kind: 'checking' }); void readInvites(); });
  const [orgName, setOrgName] = useState('');
  const [view, setView] = useState<View>({ kind: 'choose' });
  const [rateLine, setRateLine] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  // story 4713 AC2: the person's own radio choice belongs to the folder it was made for — a folder picked afterwards starts from what ITS marks say again
  const [pickedFor, setPickedFor] = useState<{ folderKey: string; runtime: DesktopRuntime } | null>(null);
  const [wideOk, setWideOk] = useState(false);
  // story 4784: what the person typed for the new agent. null name = the tool's name stays in the field (it follows the tool picked). The folder window reloads
  // this page, so both wait in the tab's session storage per setup and are read back once after mount.
  const [nameTyped, setNameTyped] = useState<string | null>(null);
  const [roleTyped, setRoleTyped] = useState('');
  const typedRead = useRef(false);
  const [focusAsk, setFocusAsk] = useState<{ id: string; n: number } | null>(null); // a refused name/role: the cursor goes to that field once the card is back (the line sits under the button)
  useEffect(() => { if (focusAsk && view.kind === 'choose') document.getElementById(focusAsk.id)?.focus(); }, [focusAsk, view.kind]);
  /** the one project of a free organization that the 402 named; chosen by [넣고 시작] only */
  // codex self-QA: the setup this start made is the SERVER's (`setup_id` in its answer); the address's `setup=` is only the fallback (an older answer without it)
  const [madeSetupId, setMadeSetupId] = useState<string | null>(null);
  const [limitAskRaw, setLimitAsk] = useState<{ id: string; name: string; folderKey: string } | null>(null);
  // story 4717 (follow-up · PO 05:04Z): the plan's agent room for an organization's setup (the admin's — anyone else stops at «not admin»).
  // The recipe list carries it (the server's one count — «시스템 발행» left out). A new organization always has room for this one agent,
  // so it is not read there. Not read · no limit · a shape this page does not read → nothing said and nothing held.
  const [agentRoom, setAgentRoom] = useState<AgentRoom | null>(null);
  useEffect(() => {
    if (orgMode.kind !== 'has-org' || !isAdmin || agent) return; // the `agent=` move makes no new agent — nothing to count
    let off = false;
    fetchWithAuth('/api/desktop/recipes')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { agent_room?: unknown } | null) => { if (!off) setAgentRoom(agentRoomOf(body?.agent_room)); })
      .catch(() => { /* nothing said */ });
    return () => { off = true; };
  }, [orgMode.kind, isAdmin, orgId, agent]);
  const [copied, setCopied] = useState<DesktopRuntime | null>(null);

  const inviteReads = useRef(0); // codex self-QA: only the LATEST read decides (a late failure must not overwrite a read that already succeeded)
  async function readInvites() {
    const mine = ++inviteReads.current;
    try {
      const list = await fetchMyInvites();
      if (mine !== inviteReads.current) return;
      setOrgMode(list.length ? { kind: 'invited', invites: list } : { kind: 'new' });
    } catch {
      if (mine !== inviteReads.current) return;
      setOrgMode({ kind: 'invite-failed' }); // story 4711 AC4: not knowing is not "no invites" — the card says so and reads again
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
  const agentProject = agent ? (projectId ?? (orgProjects.length === 1 ? orgProjects[0]!.projectId : undefined)) : undefined;
  const folder = query.folder && !isFolderRefused(query.folder) ? query.folder : undefined;
  const folderKey = `${folder?.shown ?? ''}|${(folder?.traces ?? []).join(',')}`;
  const pickedRuntime = pickedFor && pickedFor.folderKey === folderKey ? pickedFor.runtime : null;
  // story 4713 AC2: a folder with a CLAUDE.md / AGENTS.md picks the program that mark means (when this computer has it); the person's own radio beats it
  const traceHit = agent ? null : folderTracePick(folder, usable);
  const runtime = agent ? agent.runtime : pickedRuntime && usable.includes(pickedRuntime) ? pickedRuntime : traceHit?.runtime ?? defaultSoloRuntime(usable, query.pick);
  // codex self-QA: the free plan's «넣고 시작» question belongs to the folder it was asked for — another folder picked afterwards (same page, new address) must not start into A's project
  const limitAsk = limitAskRaw && limitAskRaw.folderKey === (folder?.shown ?? '') ? limitAskRaw : null;
  const refused = isFolderRefused(query.folder) ? query.folder.refused : null;
  // the project the app found for this folder counts only if this organization really has it — else it is a new project by the folder's name
  const matched = folder?.projectId && !newOrg ? orgProjects.find((p) => p.projectId === folder.projectId) : undefined;
  const projectLine = !folder ? null
    : limitAsk ? { kind: 'chosen' as const, name: limitAsk.name }
    : matched ? { kind: 'existing' as const, name: matched.projectName }
    : { kind: 'new' as const, name: newOrg ? folder.name : shownProjectName(folder.name, orgProjects.map((p) => p.projectName)) };
  const block = soloStartBlock(runtime, folder, wideOk);
  const agentName = (nameTyped ?? (runtime ? RUNTIME_LABEL[runtime] : '')).trim();
  const nameBlank = !agent && !!runtime && agentName === '';
  useEffect(() => {
    if (agent) return;
    if (!typedRead.current) {
      typedRead.current = true;
      const saved = readTypedAgent(query.setupId ?? null);
      if (saved.name !== null || saved.role) { setNameTyped(saved.name); setRoleTyped(saved.role); return; }
    }
    writeTypedAgent(query.setupId ?? null, nameTyped, roleTyped);
  }, [agent, query.setupId, nameTyped, roleTyped]);
  // story 4717 (follow-up · PO 05:04Z): the one new agent this card makes does not fit the plan — «시작» off, said before the press
  const roomFull = !agent && roomShort(agentRoom, 1); // the `agent=` move confirmation makes no new agent — the room never holds it
  // story 4713 (Yuna's walk 10-17 · PO 10-17): what goes to the Mac folder window — and comes back in the next folder's address — is only what the PERSON chose
  // (their radio · an earlier echo of theirs), never the program a folder's CLAUDE.md / AGENTS.md picked: a mark's pick belongs to that folder and is gone with it,
  // so the next folder (no mark) starts from the usual default again; a person's own choice stays.
  const echoRuntime = agent ? runtime : pickedRuntime && usable.includes(pickedRuntime) ? pickedRuntime : defaultSoloRuntime(usable, query.pick);
  const folderLink = appSetupLink(app, 'folder', { pick: echoRuntime });

  // codex self-QA: two presses before the state commits must not send two confirmations (and two phone-control PUTs)
  const startInFlight = useRef(false);
  /** story 4711 (`agent=` branch): the recruiter's agent is an agent the organization ALREADY has → the confirmation is the move («existing» row, no recipe,
   *  no new agent): the exchange then revokes every key the agent had (`_rotate_existing_agent`) — the key the hire handed to the browser dies there. */
  async function startAgent() {
    if (!agent || !agentProject || startInFlight.current) return; // the same one-press guard as start()
    startInFlight.current = true;
    setRateLine(null); setErrorLine(null); setView({ kind: 'starting' });
    try {
      const res = await fetchWithAuth('/api/desktop/setup-codes/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(moveConfirmBody(query.code, agentProject, [agent.id])),
      });
      if (res.ok) {
        // the setup this move belongs to is the SERVER's (`setup_id` in its answer, shape-checked); the address's `setup=` is only the fallback (codex self-QA)
        const okBody = await res.json().catch(() => null) as { setup_id?: string } | null;
        const made = progressIdOf(okBody?.setup_id, query.setupId);
        setMadeSetupId(made);
        if (!projectId && !(await joinNewOrg({ project_id: agentProject }))) { setView({ kind: 'done-reload' }); return; }
        await turnPhoneControlOn(orgId);
        if (made) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + PROGRESS_FRAGMENT(made)); // a reload goes back to the progress (as the solo start does)
        setView({ kind: 'started' });
        return;
      }
      const body = await res.json().catch(() => null);
      const error = body?.error as { code?: string } | undefined;
      if (res.status === 429 || error?.code === 'RATE_LIMITED') {
        const secs = Number(res.headers.get('Retry-After'));
        const time = !Number.isFinite(secs) || secs <= 0 ? t('rateLimitedMoment') : secs < 60 ? t('rateLimitedSeconds', { n: Math.ceil(secs) }) : t('rateLimitedMinutes', { n: Math.ceil(secs / 60) });
        setRateLine(t('rateLimited', { time })); setView({ kind: 'choose' }); return;
      }
      const failure = moveFailureForCode(error?.code);
      if (failure === 'move-not-admin') setView({ kind: 'failed', failure: 'not-admin' });
      else if (failure === 'expired') setView({ kind: 'failed', failure: 'expired' });
      else if (failure === 'move-changed' && onNotMovable) onNotMovable(); // the agent left the project / is gone: the recipe page with its reasons (self-QA), never the same card again
      else { setErrorLine(t('quick.failed')); setView({ kind: 'choose' }); }
    } catch {
      setView({ kind: 'failed', failure: 'offline' });
    } finally {
      startInFlight.current = false;
    }
  }

  async function start(useProject?: string) {
    if (startInFlight.current) return;
    startInFlight.current = true;
    try { await startOnce(useProject); } finally { startInFlight.current = false; }
  }
  async function startOnce(useProject?: string) {
    if (!runtime || !folder || soloStartBlock(runtime, folder, wideOk) || agentName === '' || roomFull) return;
    setRateLine(null);
    setErrorLine(null);
    setView({ kind: 'starting' });
    const json = { method: 'POST', headers: { 'Content-Type': 'application/json' } } as const;
    try {
      const res = newOrg
        ? await fetchWithAuth('/api/desktop/setup-codes/confirm-solo-new-org', { ...json, body: JSON.stringify(soloNewOrgConfirmBody(query.code, runtime, folder, orgName, { name: agentName, role: roleTyped })) })
        : await fetchWithAuth('/api/desktop/setup-codes/confirm-solo', { ...json, body: JSON.stringify(soloConfirmBody(query.code, runtime, matched ? folder : { ...folder, projectId: undefined }, { name: agentName, role: roleTyped }, useProject)) });
      if (res.ok) {
        const okBody = await res.json().catch(() => null) as { project_id?: string; org_id?: string; setup_id?: string } | null;
        const made = progressIdOf(okBody?.setup_id, query.setupId);
        setMadeSetupId(made);
        // the tab has no project (or no organization) yet: the one made (or used) becomes the tab's, the way the recipe setup does
        if ((newOrg || !projectId) && !(await joinNewOrg(newOrg ? okBody : { project_id: okBody?.project_id ?? useProject ?? matched?.projectId }))) { setView({ kind: 'done-reload' }); return; }
        await turnPhoneControlOn(newOrg ? okBody?.org_id ?? null : orgId); // story 4670 AC1: after the start went through — the one PUT, or none
        // a reload from here goes back to this setup's progress (the id is in the address the app opened), not to «앱에서 열어 주세요» — as the recipe page's reload does (4429 ①)
        if (made) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + PROGRESS_FRAGMENT(made));
        setView({ kind: 'started' });
        return;
      }
      const body = await res.json().catch(() => null);
      const error = body?.error as { code?: string; resource?: string; limit?: unknown } | undefined;
      const out = soloOutcome(res.status, error, res.headers.get('Retry-After'), (body as { detail?: unknown } | null)?.detail);
      switch (out.kind) {
        case 'rate-limited': {
          const secs = out.retryAfter;
          const time = secs === null ? t('rateLimitedMoment') : secs < 60 ? t('rateLimitedSeconds', { n: Math.ceil(secs) }) : t('rateLimitedMinutes', { n: Math.ceil(secs / 60) });
          setRateLine(t('rateLimited', { time }));
          setView({ kind: 'choose' });
          return;
        }
        case 'use-existing-project': setLimitAsk({ ...out.project, folderKey: folder.shown }); setView({ kind: 'choose' }); return;
        case 'name-taken':
          // story 4784: never renamed behind their back — the free name goes into the field, the line says so, and «만들기» is theirs to press again
          if (out.suggested) setNameTyped(out.suggested);
          setFocusAsk((f) => ({ id: 'quick-agent-name', n: (f?.n ?? 0) + 1 }));
          setErrorLine(out.suggested ? t('quick.nameTaken', { name: out.suggested }) : t('quick.nameTakenNoSuggestion'));
          setView({ kind: 'choose' });
          return;
        case 'bad-text':
          // story 4784: say which field and why — a retry of the same text could never go through
          setErrorLine(out.field === 'agent_role' ? t('quick.roleInvalid') : out.blank ? t('quick.nameBlankLooking') : t('quick.nameInvalid'));
          setFocusAsk((f) => ({ id: out.field === 'agent_role' ? 'quick-agent-role' : 'quick-agent-name', n: (f?.n ?? 0) + 1 }));
          setView({ kind: 'choose' });
          return;
        case 'project-limit': setErrorLine(t('firstProject.limit', { limit: typeof error?.limit === 'number' ? error.limit : 1 })); setView({ kind: 'choose' }); return;
        case 'agent-limit': setView({ kind: 'failed', failure: 'agent-limit', counts: limitCounts(body?.error), plan: agentLimitOf(402, body) }); return;
        case 'not-admin': setView({ kind: 'failed', failure: 'not-admin' }); return;
        case 'expired': setView({ kind: 'failed', failure: 'expired' }); return;
        case 'has-org': setView({ kind: 'failed', failure: 'has-org' }); return;
        case 'pending-invites': await readInvites(); setView({ kind: 'choose' }); return;
        case 'email-verify': setErrorLine(tOnboarding('emailVerifyRequiredError')); setView({ kind: 'choose' }); return;
        default: setErrorLine(t('quick.createFailed')); setView({ kind: 'choose' });
      }
    } catch {
      setView({ kind: 'failed', failure: 'offline' });
    }
  }

  if (orgMode.kind === 'invite-failed') return <InviteCheckFailedCard onRetry={() => { setOrgMode({ kind: 'checking' }); void readInvites(); }} />;
  if (newOrg && verifyGate.kind === 'closed') return <EmailVerifyGateCard gate={verifyGate} />;
  if (orgMode.kind === 'checking' || (newOrg && verifyGate.kind === 'reading')) return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  // the setup values are only in memory (the page took them off the address): a reload that lands on THIS page puts them back first
  const reloadKeepingSetup = () => { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + setupFragment(query)); window.location.reload(); };
  if (orgMode.kind === 'invited') return <InvitedInApp invites={orgMode.invites} onReload={reloadKeepingSetup} />;
  if (orgMode.kind === 'has-org' && !isAdmin) return <Failure failure="not-admin" onReloadPage={reloadKeepingSetup} />;
  if (view.kind === 'done-reload') return <SetupDoneReload setupId={madeSetupId} />;
  if (view.kind === 'started') return <SetupProgressView setupId={madeSetupId} recipeName="" phoneControlFailed={phoneControlFailed} onPhoneRetry={retryPhoneControl} />;
  if (view.kind === 'failed') {
    const onReloadPage = view.failure === 'has-org' || view.failure === 'not-admin' ? reloadKeepingSetup : undefined;
    return <Failure failure={view.failure} counts={view.counts ?? null} plan={view.plan ?? null} solo onRetry={view.failure === 'offline' ? () => void (agent ? startAgent() : start(limitAsk?.id)) : undefined} onReloadPage={onReloadPage} />;
  }
  // nothing usable on this computer: blocked by the company's policy · installed but too old · not found (the install lines)
  if (!agent && usable.length === 0) {
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
  const blockLine = block === 'no-agent' ? t('quick.blockNoAgent') : block === 'no-folder' ? t('quick.blockNoFolder') : block === 'wide-unconfirmed' ? t('quick.blockWide') : nameBlank ? t('quick.blockName') : null;
  const withVersion = (r: DesktopRuntime) => query.versions?.[r];
  return (
    <div className="flex flex-col gap-3">
      <Card className="break-keep flex flex-col gap-5 p-6" data-testid="quick-card">
        {/* story 4710 (Yuna 4710-copy-1016 · the correction's «{name} 에이전트 시작하기»): from a hire the card is about THAT agent */}
        <h1 className="text-lg font-semibold">{agent ? t('quick.titleAgent', { name: agent.name }) : t('quick.title')}</h1>

        <section aria-labelledby="quick-step-agent" className="flex flex-col gap-2">
          <h2 id="quick-step-agent" className="text-sm font-medium">① {agent ? t('quick.stepAgent') : t('quick.stepTool')}</h2>
          {agent ? (
            // story 4711 (`agent=` branch): the recruiter's agent — one read-only line (no radio, nothing to choose), the move's warning when it works elsewhere
            <div data-testid="quick-agent-fixed">
              <p className="flex items-center gap-2 text-sm"><span>{agent.name}</span><span className="text-xs text-muted-foreground">{RUNTIME_LABEL[agent.runtime]}{query.versions?.[agent.runtime] ? ` ${query.versions[agent.runtime]}` : ''}</span></p>
              <MovedAgentNote agent={agent} />
            </div>
          ) : usable.length > 1 ? (
            <div role="radiogroup" aria-labelledby="quick-step-agent" className="flex flex-col gap-1">
              {usable.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="quick-runtime" checked={runtime === r} onChange={() => setPickedFor({ folderKey, runtime: r })} onClick={() => setPickedFor({ folderKey, runtime: r })} /> {/* onClick too: pressing the radio a folder's mark already picked fires no change event, yet it is the person's own choice (4713 · codex 01a151a1) */}
                  <span>{RUNTIME_LABEL[r]}</span>
                  {withVersion(r) ? <span className="text-xs text-muted-foreground">{withVersion(r)}</span> : null}
                </label>
              ))}
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm"><span>{runtime ? RUNTIME_LABEL[runtime] : ''}</span>{runtime && withVersion(runtime) ? <span className="text-xs text-muted-foreground">{withVersion(runtime)}</span> : null}</p>
          )}
          {traceHit && runtime === traceHit.runtime ? (
            <p className="text-xs text-muted-foreground" data-testid="quick-trace">{t('quick.traceDefault', { file: traceHit.file, iga: pickIGaJosa(traceHit.file), runtime: RUNTIME_LABEL[traceHit.runtime], euro: pickEuroJosa(RUNTIME_LABEL[traceHit.runtime]) })}</p>
          ) : null}
          {(query.old ?? []).map((o) => (
            <p key={o.runtime} className="text-xs text-muted-foreground">{t('quick.tooOld', { name: RUNTIME_LABEL[o.runtime], version: o.version })}</p>
          ))}
        </section>

        {agent || !runtime ? null : (
        <section aria-labelledby="quick-step-name" className="flex flex-col gap-3">
          <h2 id="quick-step-name" className="text-sm font-medium">② {t('quick.stepName')}</h2>
          <div className="flex flex-col gap-1">
            <label htmlFor="quick-agent-name" className="text-xs text-muted-foreground">{t('quick.nameLabel')}</label>
            <Input id="quick-agent-name" data-testid="quick-agent-name" value={nameTyped ?? RUNTIME_LABEL[runtime]} maxLength={AGENT_NAME_MAX} disabled={starting}
              aria-invalid={nameBlank} onChange={(e) => { setNameTyped(e.target.value); setErrorLine(null); }} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="quick-agent-role" className="text-xs text-muted-foreground">{t('quick.roleLabel')}</label>
            <Input id="quick-agent-role" data-testid="quick-agent-role" value={roleTyped} maxLength={AGENT_ROLE_MAX} disabled={starting}
              placeholder={t('quick.rolePlaceholder')} aria-describedby="quick-role-hint" onChange={(e) => setRoleTyped(e.target.value)} />
            <p id="quick-role-hint" className="text-xs text-muted-foreground" data-testid="quick-role-hint">{t('quick.roleHint')}</p>
          </div>
        </section>
        )}

        {agent ? null : (
        <section aria-labelledby="quick-step-folder" className="flex flex-col gap-2">
          <h2 id="quick-step-folder" className="text-sm font-medium">③ {t('quick.stepFolder')}</h2>
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
        )}

        {limitAsk ? (
          <div role="status" className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="quick-limit">
            <p className="font-medium">{t('quick.limit.title')}</p>
            <p>{t('quick.limit.body', { project: limitAsk.name })}</p>
            {/* codex self-QA (4717): the room can fill after the press that raised this question — the button is held and the reason said, never a silent no-op */}
            {roomFull && agentRoom ? (
              <RoomShortBox room={agentRoom} line={t('room.soloNone')}
                hint={<p className="text-xs text-muted-foreground" data-testid="quick-room-use-team">{t('room.soloUseTeam')}</p>} />
            ) : null}
            {nameBlank ? <p className="text-xs text-muted-foreground" data-testid="quick-limit-name-blank">{t('quick.blockName')}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={starting || roomFull || nameBlank} onClick={() => void start(limitAsk.id)}>{starting ? t('quick.creating') : t('quick.limit.addStart')}</Button>
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
              {showPhoneControl ? (
                // story 4670 AC1 (Yuna §M): a bordered box, the phone icon, a semibold label, a bigger tick — one line inside the third step, just above «시작»
                <div className="flex gap-3 rounded-md border p-3" data-testid="setup-phone-control">
                  <input type="checkbox" id="quick-phone-control" checked={phoneControl} onChange={(e) => setPhoneControl(e.target.checked)} disabled={starting} className="mt-0.5 size-5 shrink-0 self-start accent-primary" />
                  <label htmlFor="quick-phone-control" className="block min-w-0 flex-1 cursor-pointer break-keep">
                    <span className="flex items-center gap-1.5 text-sm font-semibold"><Smartphone className="size-4 shrink-0 text-primary" aria-hidden />{t('phoneControl.label')}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t('phoneControl.help')}</span>
                  </label>
                </div>
              ) : null}
              {roomFull && agentRoom ? (
                <RoomShortBox room={agentRoom} line={t('room.soloNone')}
                  hint={<p className="text-xs text-muted-foreground" data-testid="quick-room-use-team">{t('room.soloUseTeam')}</p>} />
              ) : null}
              <div><Button disabled={starting || (agent ? !agentProject : block !== null || nameBlank || roomFull)} aria-describedby="quick-start-line" onClick={() => void (agent ? startAgent() : start())}>{agent ? (starting ? t('quick.starting') : t('quick.start')) : (starting ? t('quick.creating') : t('quick.create'))}</Button></div>
              <p id="quick-start-line" className="text-sm text-muted-foreground" data-testid="quick-start-line">
                {agent ? (agentProject ? t('quick.projectChosen', { name: orgProjects.find((p) => p.projectId === agentProject)?.projectName ?? '' }) : '')
                  : blockLine ?? (runtime && projectLine
                    ? t('quick.createLine', { name: agentName, runtime: `${name}`, project: projectLine.name })
                    : '')}
              </p>
              {agent ? null : <p className="text-xs text-muted-foreground" data-testid="quick-create-nothing">{t('quick.createNothing')}</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('toolNote')}</p>
        </section>
      </Card>
      {agent ? null : <p className="text-sm"><Button type="button" variant="link" className="h-auto p-0 underline underline-offset-2" disabled={starting} onClick={onTeam}>{t('quick.team')}</Button></p>}
    </div>
  );
}

/**
 * story 4711 — the page opened WITH a recruiter's agent (`agent=<member id>` in the address, from the in-app hire's [이 컴퓨터에서 시작]): the card is
 * the same three-step card with ① FIXED to that agent, and «시작» is the MOVE confirmation — the agent is one the organization already has, never a new
 * one, so the exchange revokes every key it had (`_rotate_existing_agent`): the key the hire handed to the browser dies there (Kadir's lens on 5123).
 * Only when the agent can really be moved now (in this project · its program on this computer · the person can move it); otherwise the recipe page
 * with its reasons (4703 `PreselectHold`) — never a quiet fall to a new agent. While the list is read: the loading card.
 */
export function DesktopSetupAgent({ query, onTeam }: { query: SetupQuery; onTeam: () => void }) {
  const t = useTranslations('desktop.setup');
  const { projectId, orgId, orgMemberships, projectMemberships } = useDashboardContext();
  const isAdmin = ['owner', 'admin'].includes(orgMemberships?.find((o) => o.orgId === orgId)?.role ?? 'member');
  const orgProjects = useMemo(() => (projectMemberships ?? []).filter((m) => !m.orgId || m.orgId === orgId), [projectMemberships, orgId]);
  const project = projectId ?? (orgProjects.length === 1 ? orgProjects[0]!.projectId : undefined);
  const wanted = !!orgId && isAdmin && !!project;
  const [read, setRead] = useState<{ project: string; agents: AttachableAgent[] | null } | null>(null);
  const [gone, setGone] = useState(false); // the move said «not movable now»: the recipe page from here on
  useEffect(() => {
    if (!wanted || !project) return;
    let off = false;
    // a read that never ends (headers or body) is a «could not read» after the same limit the recipe page uses — the recipe page then, never a spinner for good
    const limit = setTimeout(() => { if (!off) setRead({ project, agents: null }); }, ATTACHABLE_READ_LIMIT_MS);
    fetchWithAuth(`/api/desktop/setup/agents?project_id=${encodeURIComponent(project)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { agents?: AttachableAgent[] } | null) => { if (!off) setRead({ project, agents: Array.isArray(body?.agents) ? body.agents : null }); })
      .catch(() => { if (!off) setRead({ project, agents: null }); })
      .finally(() => clearTimeout(limit));
    // leaving a project (or the page): nothing of its answer is kept for the next one — A → B → A never shows A's old list while A is read again (self-QA)
    return () => { off = true; clearTimeout(limit); setRead(null); };
  }, [wanted, project]);
  const fallback = <DesktopSetup code={query.code} runtimes={query.runtimes} blocked={query.blocked} setupId={query.setupId} old={query.old ?? []} canMove={query.canMove === true} preselect={query.agent ?? null} />;
  if (!wanted) return fallback;
  if (!read || read.project !== project) return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  const found = gone ? undefined : read.agents?.find((a) => a.id === query.agent);
  const runtimes = usableRuntimes(query);
  if (!found || movableState(found, runtimes) !== 'ok') return fallback;
  return <DesktopSetupQuick query={query} onTeam={onTeam} agent={found} onNotMovable={() => setGone(true)} />;
}
