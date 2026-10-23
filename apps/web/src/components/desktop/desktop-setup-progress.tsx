'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Check, Circle, Info, Loader2 } from 'lucide-react';
import { appSetupLink, nativeReturnApp, RETURN_APP_PARAM, type NativeReturnApp } from '@/lib/auth/native-return-app';
import { PhoneAppGet } from './phone-pairing';
import { PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET, phoneAppLinks } from '@/lib/phone-app-store';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { pickEulReulJosa, pickEunNeunJosa, pickIGaJosa } from '@/lib/korean-particle';
import { presetName } from '@/lib/platform-preset-copy';
import { stageRoleLabel } from '@/lib/stage-role';
import { storyBoardUrl } from '@/lib/entity-project-url';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { DEFAULT_NAV_V3_FLAGS, resolveNavV3Destinations } from '@/lib/nav-v3-destinations';
import { endsWithAgentWord, forgetActiveSetup, moveProgress, rememberActiveSetup, setupPollDelayMs, setupProgress, stepsShown, SETUP_STATUS_POLL_MS, type DesktopRuntime, type MoveProgress, type SetupStatus, type StepShown } from '@/lib/desktop-setup';
import { Failure, ToolsNotConnected } from './desktop-setup';
import { putOrgRemoteControl, useOrgRemoteControl } from '@/lib/org-remote-control';

/**
 * «시작» 뒤 진행 표시(유나 시안 v13 · PO 12:25Z): 설정 상태 조회(4826)를 2초마다 읽어 세 단계로. 조회는 setupProgress()의
 * settled가 참이 되면 멈춘다(story 4464): 막힘 · 만료, 또는 첫 결과 뒤 모든 에이전트가 정해짐(붙음 · 시작 실패 · 멈춤 · 문턱 넘긴
 * 안 붙음 = ⑦ 블록). 설정 id가 없으면(옛 앱) 임시 한 장만.
 */
// story 4658: the login command each runtime names for itself (the app's AUTH_COMMAND — the same two strings)
const SIGN_IN_COMMAND: Record<'claude' | 'codex', string> = { claude: 'claude auth login', codex: 'codex login' };

/** story 4658 (Yuna 4658-design.md · 480 CHANGES ①): the sentence, then the command of each runtime on its own line — the CLI's own (the app's AUTH_COMMAND) */
export function SignInBand({ runtimes }: { runtimes: DesktopRuntime[] }) {
  const t = useTranslations('desktop.setup');
  if (runtimes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-sign-in">
      <p>{t('signInBody')}</p>
      {runtimes.map((r) => <code key={r} className="block break-all text-xs">{SIGN_IN_COMMAND[r]}</code>)}
    </div>
  );
}

export function SetupProgressView({ setupId, recipeName, phoneControlFailed = false, onPhoneRetry }: { setupId: string | null; recipeName: string; phoneControlFailed?: boolean; /** story 4711 (PO 10-16): a solo start whose «폰으로도 다루기» switch did not turn on — turns it on again; true = it did */ onPhoneRetry?: () => Promise<boolean> }) {
  const t = useTranslations('desktop.setup');
  const tOnboarding = useTranslations('onboarding'); // story 4711: [대화 열기] is the words the first-instruction card already uses (Yuna)
  const locale = useLocale();
  const tOrg = useTranslations('organization');
  const tPreset = useTranslations('recipePreset');
  const { orgId, orgMemberships, currentProjectSlug, navV3Flags } = useDashboardContext();
  const flatHref = useFlatHref();
  // story 4670 (U2): the end card's [폰 페어링 열기] is for an owner/admin (the same reading as the setup page's isAdmin); the link names
  // the app that opened this page (story #4626 · `?app=`)
  const orgRole = orgMemberships?.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = orgRole === 'owner' || orgRole === 'admin';
  const app = nativeReturnApp(useSearchParams()?.get(RETURN_APP_PARAM));
  // one reading: the status, when it was read, and when this page first saw «handed_over» (the status carries no such time)
  const [snap, setSnap] = useState<{ status: SetupStatus; at: number; handedOverSeenAt: number | null } | null>(null);
  const stopped = useRef(false);
  // story 4468 (Qadir 4880 second line): [다시 확인] and the 2 s reading can overlap — readings are numbered when they go out, and
  // an answer older than the one already shown is dropped (it used to put the page back to an earlier state)
  const reads = useRef({ sent: 0, shown: 0 });

  const poll = useCallback(async () => {
    if (!setupId) return;
    const n = ++reads.current.sent;
    try {
      const res = await fetchWithAuth(`/api/desktop/setups/${setupId}`);
      if (!res.ok) return; // 한 번 못 읽으면 다음 판에 다시(화면은 그대로)
      const body = (await res.json()) as SetupStatus | { data?: SetupStatus };
      const s = 'signals' in body ? body : body.data ?? null;
      if (!s) return;
      if (n < reads.current.shown) return; // a newer answer is already on the page
      reads.current.shown = n;
      // «설정 진행 중» 표시(문서 열림 셈 · AC2): 흐름이 끝나면 지우고, 아니면 읽을 때마다 새로 적는다(PO 13:00Z)
      // story #4576: a move has no first result — its flow ends when every agent is settled
      if (s.signals.first_result_at || s.signals.blocked || s.state === 'not_handed_over' || s.state === 'disconnected'
        || ((s.setup_kind === 'move' || s.setup_kind === 'solo') && moveProgress(s, Date.now(), null).settled)) forgetActiveSetup();
      else rememberActiveSetup(setupId);
      const at = Date.now();
      setSnap((prev) => ({ status: s, at, handedOverSeenAt: prev?.handedOverSeenAt ?? (s.state === 'handed_over' ? at : null) }));
    } catch { /* 연결이 잠깐 끊겨도 다음 판에 다시 */ }
  }, [setupId]);

  const status = snap?.status ?? null;
  const progress = snap ? setupProgress(snap.status, snap.at, snap.handedOverSeenAt) : null;
  // story #4576: a move («이미 있는 에이전트 옮기기») has its own two steps — the server says which (setup_kind)
  // story 4711: a solo start (the first setup in three steps) has the same two steps — one agent, no recipe, no first task or result
  const move = snap && (snap.status.setup_kind === 'move' || snap.status.setup_kind === 'solo') ? moveProgress(snap.status, snap.at, snap.handedOverSeenAt) : null;
  // story 4711 AC2: the first screen after a solo start is the conversation with that agent — opened once the app has taken the agent
  // over (the folder-trust question, if Claude Code asks it, shows there). Once: a person who comes back to the page is not sent again.
  const soloRoom = snap?.status.setup_kind === 'solo' && snap.status.state === 'handed_over' ? snap.status.conversation_id ?? null : null;
  const opened = useRef(false);
  // story 4711 (PO 10-16): when the tick was on but the switch did not turn on, the person is NOT sent to the conversation on their own: the card
  // says so and they choose — [다시 켜기] (on success the conversation opens as usual) or [대화 열기]. A start that went well, or a tick left off, is
  // sent at once as before.
  const [phoneRetrying, setPhoneRetrying] = useState(false);
  const holdRoom = phoneControlFailed && !!onPhoneRetry; // [다시 켜기] succeeding clears `phoneControlFailed` in the card's state — the hold ends and the conversation opens
  useEffect(() => {
    if (!soloRoom || opened.current || holdRoom) return;
    opened.current = true;
    window.location.assign(flatHref(`/chats/${soloRoom}`)); // a full load: the page's address holds nothing to keep, and a new token may be needed
  }, [soloRoom, flatHref, holdRoom]);
  // story 4464 — keep reading until every agent is in (PO 12:04Z: also while a block waits for the person — once they act and the
  // agent connects, the block goes); after 2 minutes of such waiting, every 10 s instead of 2
  const done = move ? move.settled : !!progress && progress.settled;
  useEffect(() => { stopped.current = done; }, [done]);
  const delay = progress && status && !move ? setupPollDelayMs(progress, status.signals.first_result_at, snap!.at) : SETUP_STATUS_POLL_MS;

  useEffect(() => {
    if (!setupId) return;
    // the first reading right away (on the next task — no state change inside the effect itself)
    const first = window.setTimeout(() => void poll(), 0);
    return () => { window.clearTimeout(first); };
  }, [setupId, poll]);
  useEffect(() => {
    if (!setupId) return;
    const timer = window.setInterval(() => { if (!stopped.current) void poll(); }, delay);
    return () => { window.clearInterval(timer); };
  }, [setupId, poll, delay]);

  if (soloRoom && holdRoom) {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6" data-testid="solo-phone-failed">
        <p className="text-sm" role="status">{t('phoneControl.failedStopped')}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={phoneRetrying} onClick={() => { setPhoneRetrying(true); void onPhoneRetry!().finally(() => setPhoneRetrying(false)); }}>{t('phoneControl.again')}</Button>
          <Button variant="outline" onClick={() => { opened.current = true; window.location.assign(flatHref(`/chats/${soloRoom}`)); }}>{tOnboarding('firstInstructionOpenConversation')}</Button>
        </div>
      </Card>
    );
  }
  if (!progress || !status) {
    return (
      <Card className="break-keep p-6">
        <h1 className="text-lg font-semibold">{t('startedTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p>
        {phoneControlFailed ? <PhoneControlFailedLine /> : null}
      </Card>
    );
  }
  // story 4498 (PO 10:50Z · Yuna 10:51Z): a disconnected setup ends here — whatever the steps had reached before (a result
  // shown before the disconnect is not drawn as «done»: nothing continues), and opened again by its address the same card
  if (progress.disconnected) return <Failure failure="disconnected" todayHref={flatHref(resolveNavV3Destinations(navV3Flags ?? DEFAULT_NAV_V3_FLAGS).today.path)} />;
  if (move) return <MoveProgressBody move={move} onRetry={() => void poll()} todayHref={flatHref(resolveNavV3Destinations(navV3Flags ?? DEFAULT_NAV_V3_FLAGS).today.path)} phoneControlFailed={phoneControlFailed} isAdmin={isAdmin} app={app} />;
  if (progress.blocked) return <Failure failure="managed" />;
  if (progress.expired) return <Failure failure="expired" />;
  // the folder-trust question is Claude Code's (Codex does not ask it) — Yuna v24 · PO 11:19Z
  const claude = status.members.some((m) => m.kind === 'agent' && m.runtime === 'claude');
  // story 4452 (Yuna v32 · PO 06:06Z): with an agent that could not start on the page, ⑦ does not cover it — it is a block
  // below the others; with none, ⑦ stays the card (the only fork: is there a start failure)
  // once the first result is in, the three steps are done: ⑦ is the block below them, never a card over them (story 4464)
  if (progress.notConnected && progress.startFailed.length === 0 && progress.result !== 'done') return <ToolsNotConnected onRetry={() => void poll()} claude={claude} />;

  const role = (r: string) => stageRoleLabel(r, tOrg);
  // roles shown as one group, and whether «에이전트» / «agent» is added after them: a name that already ends in it gets none
  // (the last one decides — Yuna v29), and the Korean particle follows the name then
  const roleGroup = (roles: string[]) => {
    // the names come trimmed from setupProgress (one place — PO 16:41Z), so the check and the words see the same name
    const names = roles.map(role);
    const last = names.at(-1) ?? '';
    return { text: names.join(' · '), last, bare: endsWithAgentWord(last, locale), count: names.length };
  };
  const RUNTIME: Record<DesktopRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };
  // the first agent's name follows the same rule as the title (Yuna v29 — never «에이전트 에이전트»), its particle the name it ends in
  const firstNotReadyLine = (firstRole: string | null) => {
    if (!firstRole) return t('startFailed.firstNotReadyNoRole');
    const first = role(firstRole);
    return endsWithAgentWord(first, locale) ? t('startFailed.firstNotReadyBare', { firstRole: first, josa: pickIGaJosa(first) }) : t('startFailed.firstNotReady', { firstRole: first });
  };
  // one name in one flow (PO 10:39Z ①): the recipe as the list names it — a platform preset by its translation, not the stored
  // name — from the server's recipe (also when the page is opened again without the list's name)
  const task = status.recipe ? presetName(status.recipe, tPreset) : (recipeName || status.recipe_name || '');
  const orgSlug = orgMemberships?.find((o) => o.orgId === orgId)?.orgSlug;
  const resultHref = status.work_item_id && orgSlug && currentProjectSlug
    ? storyBoardUrl(orgSlug, currentProjectSlug, status.work_item_id)
    : status.work_item_id ? flatHref(`/flow?story=${status.work_item_id}`) : null;
  const resultReady = progress.result === 'done' && !!resultHref;
  // story 4492: one spinner (the earliest step not done) · the later ones wait with their own words
  const [readyShown, handedShown, resultShown] = stepsShown(progress);
  // story 4492 — «오늘» from the one destination module (no literal path). An org-less person on this page has no dashboard
  // shell (no flags in the context) — the default flags then, the same as the shell's own default.
  const todayHref = flatHref(resolveNavV3Destinations(navV3Flags ?? DEFAULT_NAV_V3_FLAGS).today.path);

  return (
    <Card className="break-keep flex flex-col gap-4 p-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')}{task ? ` · ${task}` : ''}</p>
        <h1 className="text-lg font-semibold">{progress.result === 'done' ? t('startedDoneTitle') : t('startedTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p>
        {/* story 4670 (Yuna §E ②): the «폰에서도 다루기» tick was on but the switch did not turn on — the setup went on; the way is the card below */}
        {phoneControlFailed ? <PhoneControlFailedLine /> : null}
      </header>
      <ol className="flex flex-col gap-3" aria-live="polite">
        {/* a later step done → the earlier one is drawn done (Yuna 12:22Z): ② proves the receiving agent was ready; the pairs line
            stays for when every agent is really ready, and the others still getting ready are ①'s own detail (not a list item) */}
        <Step state={readyShown} paused={progress.readyPaused} label={progress.readyDrawn === 'done' ? t('stepReadyDone') : t('stepReadyRunning')}
          detail={progress.ready === 'done' ? progress.pairs.map((p) => `${role(p.role)} · ${RUNTIME[p.runtime]}`).join(', ')
            : progress.stillPreparing.length > 0 ? (() => {
              const g = roleGroup(progress.stillPreparing);
              return g.bare ? t('stillPreparingBare', { roles: g.text, josa: pickEunNeunJosa(g.last), count: g.count }) : t('stillPreparing', { roles: g.text, count: g.count });
            })() : null}
          detailTestId={progress.ready !== 'done' && progress.stillPreparing.length > 0 ? 'setup-still-preparing' : undefined}>
          {/* the notes belong to their step's list item (same place on screen: the step's text column is 28px in) — never a list
              item of their own, so a screen reader counts three steps */}
          {/* story 4492: the gate is part of getting the agents ready (①) — the note asking the person to answer sits here */}
          {progress.trustHint && claude ? (
            <span className="mt-1 flex gap-2 rounded-md bg-muted p-2 text-xs" data-testid="setup-trust-hint">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{t('trustHint')}
            </span>
          ) : null}
          {progress.workdirFallback ? (
            <span className="mt-1 flex gap-2 text-xs text-muted-foreground" data-testid="setup-workdir-fallback">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{t('workdirFallback', { recipe: task })}
            </span>
          ) : null}
        </Step>
        <Step state={handedShown} paused={progress.handedPaused} label={handedShown === 'done' ? t('stepHandedDone') : handedShown === 'waiting' ? t('stepHandedWaiting') : t('stepHandedRunning')}
          detail={progress.handed === 'running' && task && progress.firstAgentRole
            ? (() => {
              const r = role(progress.firstAgentRole);
              const v = { task, josa: pickEulReulJosa(task), role: r };
              // story 4492 (Yuna 07:17Z): while ② waits its line says what happens next, not «건네는 중» · each key spelled out
              if (handedShown === 'waiting') return endsWithAgentWord(r, locale) ? t('stepHandedWaitingDetailBare', v) : t('stepHandedWaitingDetail', v);
              return endsWithAgentWord(r, locale) ? t('stepHandedDetailBare', v) : t('stepHandedDetail', v);
            })() : null} />
        {/* while an agent is stopped, ③ does not spin — nothing is moving (Yuna v26); ① · ② likewise when all they wait for stopped (v29) */}
        <Step state={resultShown} paused={!!progress.stopped} label={resultShown === 'done' ? t('stepResultDone') : resultShown === 'waiting' ? t('stepResultWaiting') : t('stepResultRunning')} detail={null} />
      </ol>
      {progress.startFailed.length > 0 ? (
        // story 4452 (Yuna 04:41Z · 04:43Z · v31): an agent the shell could not start — its own block, before a stopped one, with
        // the real reason (the next thing to do), never red, no button here (starting is the app's: the notice's [다시 시도])
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-start-failed">
          {progress.startFailed.map((f) => {
            const name = f.role ? role(f.role) : '';
            const runtime = f.runtime ? RUNTIME[f.runtime] : null;
            // each line by its own key (the dead-key check reads them) · particles picked for the name (never a fixed 를/가)
            const rt = runtime ? { runtime, eulReul: pickEulReulJosa(runtime), iGa: pickIGaJosa(runtime) } : null;
            const line = f.line === 'sessionLimit' ? (f.limit ? t('startFailed.sessionLimit', { n: f.limit }) : t('startFailed.sessionLimitNoN'))
              : f.line === 'runtimeMissing' ? (rt ? t('startFailed.runtimeMissing', rt) : t('startFailed.unknown'))
              : f.line === 'runtimeDidNotStart' ? (rt ? t('startFailed.runtimeDidNotStart', rt) : t('startFailed.unknown'))
              : f.line === 'credentials' ? t('startFailed.credentials')
              : f.line === 'keyUnreadable' ? t('startFailed.keyUnreadable')
              : f.line === 'firstNotReady' ? firstNotReadyLine(f.firstRole)
              : f.line === 'notConnected' ? t('startFailed.notConnected')
              : f.line === 'workdirNeeded' ? t('startFailed.workdirNeeded')
              : t('startFailed.unknown');
            return (
              <div key={f.memberId} data-testid="setup-agent-start-failed-row" data-line={f.line}>
                <p>{endsWithAgentWord(name, locale) ? t('startFailed.titleBare', { role: name, josa: pickEulReulJosa(name) }) : t('startFailed.title', { role: name })}</p>
                <p className="text-muted-foreground">{line}</p>
              </div>
            );
          })}
          <p className="text-muted-foreground">{t('startFailed.where')}</p>
        </div>
      ) : null}
      {progress.signIn ? <SignInBand runtimes={progress.signIn.runtimes} /> : null}
      {progress.stopped ? (
        // story 4433 (Yuna v26): one block under the steps, above «결과 보기» · the roles on one line · body colour (there is
        // something to do), never red (the cause can be a person's own choice) · no cause guessed: «멈췄어요» covers both
        <div className="flex flex-col gap-1 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-stopped">
          <p>{(() => {
            const g = roleGroup(progress.stopped.roles);
            return g.bare ? t('stoppedBare', { roles: g.text, josa: pickIGaJosa(g.last), count: g.count }) : t('stopped', { roles: g.text, count: g.count });
          })()}</p>
          {progress.stopped.claude ? <p>{t('stoppedTrust')}</p> : null}
        </div>
      ) : null}
      {progress.notConnected ? (
        // the same weight as the blocks above (thin border · never red) · the body is ⑦'s (v24) for these agents · its button
        // stays here: checking again is the page's
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-not-connected">
          <p>{(() => {
            const g = roleGroup(progress.notConnectedAgents.roles);
            // no role names (not expected from a recipe): the tools by name, never a sentence without who
            if (g.count === 0) return t('notConnected.blockTitleBare', { roles: progress.notConnectedAgents.runtimes.map((r) => RUNTIME[r]).join(' · ') });
            return g.bare ? t('notConnected.blockTitleBare', { roles: g.text }) : t('notConnected.blockTitle', { roles: g.text, count: g.count });
          })()}</p>
          <p className="text-muted-foreground">{t(progress.notConnectedAgents.claude ? 'notConnected.bodyClaude' : 'notConnected.bodyOther')}</p>
          <div><Button variant="outline" size="sm" onClick={() => void poll()}>{t('notConnected.action')}</Button></div>
        </div>
      ) : null}
      <footer className="flex flex-col gap-1">
        {/* story 4492 (PO 06:40Z · Yuna 06:41Z): one way out, always — next to «결과 보기» (that one stays the main button). The setup
            goes on in the app (this page only reads its status); the app's «결과 보기» (#progress=) brings the person back here.
            The line replaces «결과가 나오면 …» (both would say «일감» twice). Words follow nav.zoneNow («오늘» · "Today") and
            nav.zoneDev («일감» · "Work") — change these with them. */}
        <div className="flex flex-wrap gap-2" data-testid="setup-way-out">
          {resultReady
            ? <Button asChild><a href={resultHref!}>{t('seeResult')}</a></Button>
            : <Button disabled>{t('seeResult')}</Button>}
          <Button asChild variant="outline"><a href={todayHref}>{t('goToday')}</a></Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('wayOutNote')}</p>
      </footer>
      {/* story 4670 (U2 · Yuna §E ③): once the setup is done, the phone's way in — beside the way out */}
      {done ? <PhoneHandoffCard isAdmin={isAdmin} app={app} /> : null}
    </Card>
  );
}

/** story 4670 (Yuna §E ②): the «폰에서도 다루기» tick was on but the switch did not turn on — the setup went on; the way is the card below */
function PhoneControlFailedLine() {
  const t = useTranslations('desktop.setup');
  return <p className="mt-1 text-xs text-muted-foreground" role="status" data-testid="setup-phone-control-failed">{t('phoneControl.failed')}</p>;
}

/**
 * story 4670 (UX-1 · U2 · design nwachukwu/4670-design.md §2-2 · Yuna §E ③): the end screen's «폰에서도 다루려면» — the phone app's QR
 * (U3's PhoneAppGet, the same block) and, for an owner/admin, [폰 페어링 열기]: the app's deep link `intent=pair`, which the app reads as
 * its band's [폰 페어링] pressed (sprintable-mobile · no setup starts). A member reads where pairing is done instead. The org's
 * remote-control line (§E ③e · [켜기]) joins with the switch pieces after the security lens.
 */
export function PhoneHandoffCard({ isAdmin, app }: { isAdmin: boolean; app: NativeReturnApp | null }) {
  // the file's namespace with dotted keys (the repo's i18n key check binds one namespace per hook name in a file — story #2371)
  const t = useTranslations('desktop.setup');
  const tRemote = useTranslations('desktop.remote');
  // §E ③e: the org's remote control is off and this person can switch it → a line with [켜기] that turns it on in place (the one PUT ·
  // the session's org); anyone else sees nothing here (the member's own off-line lives where it already did)
  const { orgId } = useDashboardContext();
  const [remote, setRemote] = useOrgRemoteControl(orgId);
  const [turning, setTurning] = useState<'idle' | 'busy' | 'failed'>('idle');
  const showOff = !!orgId && !!remote && remote.can_change && !remote.enabled;
  const turnOn = async () => {
    if (!orgId || turning === 'busy') return;
    setTurning('busy');
    const r = await putOrgRemoteControl(orgId);
    if (!r.ok) { setTurning('failed'); return; }
    if (r.data) setRemote(r.data);
    setTurning('idle');
  };
  // PO 5066 ① · Yuna §E ③f: whether the phone app can be got here at all — the same reading PhoneAppGet makes (it draws nothing without
  // a way in); then the body names no QR, and a member (no button either) gets no card at all — nothing to do on that screen
  const hasApp = phoneAppLinks(PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID_TARGET, PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_TEST_GROUP_TARGET).length > 0;
  if (!hasApp && !isAdmin) return null;
  return (
    <section className="flex flex-col gap-3 rounded-md border p-3" aria-labelledby="setup-phone-card-title" data-testid="setup-phone-card" data-app={hasApp ? 'yes' : 'no'}>
      <h2 id="setup-phone-card-title" className="text-sm font-medium">{t('phoneCard.title')}</h2>
      <p className="text-sm text-muted-foreground">{hasApp ? t('phoneCard.body') : t('phoneCard.bodyNoApp')}</p>
      {showOff ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="setup-phone-remote-off">
          <p className="text-sm">{t('phoneCard.remoteOff')}</p>
          <Button size="sm" variant="outline" onClick={() => void turnOn()} aria-disabled={turning === 'busy' || undefined} className="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="setup-phone-remote-on">
            {tRemote('turnOn')}
          </Button>
          {turning === 'failed' ? <p className="w-full text-xs text-destructive" role="alert" data-testid="setup-phone-remote-failed">{tRemote('failed')}</p> : null}
        </div>
      ) : null}
      {hasApp ? <PhoneAppGet /> : null}
      {isAdmin
        ? <div><Button asChild variant="outline"><a href={appSetupLink(app, 'pair')} data-testid="setup-phone-pair">{t('phoneCard.openPairing')}</a></Button></div>
        : <p className="text-xs text-muted-foreground" data-testid="setup-phone-member">{t('phoneCard.memberNote')}</p>}
    </section>
  );
}

/**
 * story #4576 (Yuna «② 옮긴 뒤 진행 표시»): a move's two steps — no first task, no result, no [결과 보기]. Agents by their own names
 * (always the `…Bare` forms: name + particle). A moved agent waiting for its folder is ①'s note (as the trust note), not a failure.
 */
function MoveProgressBody({ move, onRetry, todayHref, phoneControlFailed, isAdmin, app }: { move: MoveProgress; onRetry: () => void; todayHref: string; phoneControlFailed: boolean; isAdmin: boolean; app: NativeReturnApp | null }) {
  const t = useTranslations('desktop.setup');
  const RUNTIME: Record<DesktopRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };
  if (move.blocked) return <Failure failure="managed" />;
  if (move.expired) return <Failure failure="expired" />;
  const group = (names: string[]) => ({ text: names.join(' · '), last: names.at(-1) ?? '', count: names.length });
  const done = move.connected === 'done';
  const [readyShown, connectShown] = move.shown;
  return (
    <Card className="break-keep flex flex-col gap-4 p-6" data-testid="setup-move-progress">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')} · {t('move.eyebrowTail')}</p>
        <h1 className="text-lg font-semibold">{done ? t('move.titleDone') : t('move.titleRunning')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p>
        {phoneControlFailed ? <PhoneControlFailedLine /> : null}
      </header>
      <ol className="flex flex-col gap-3" aria-live="polite">
        <Step state={readyShown} paused={move.folderWait.length > 0} label={move.ready === 'done' ? t('stepReadyDone') : t('stepReadyRunning')}
          detail={move.pairs.length ? move.pairs.map((p) => `${p.name} · ${RUNTIME[p.runtime]}`).join(', ') : null}>
          {move.folderWait.length ? (
            <span className="mt-1 flex gap-2 rounded-md bg-muted p-2 text-xs" data-testid="setup-move-folder-wait">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {(() => { const g = group(move.folderWait); return t('move.folderWait', { names: g.text, josa: pickEunNeunJosa(g.last), count: g.count }); })()}
            </span>
          ) : null}
        </Step>
        {/* Yuna 05:20Z: in a move what is left after ① is the connection — «… 아직 준비하고 있어요» is ②'s line, never under ①'s check */}
        <Step state={connectShown} paused={move.connectPaused} label={connectShown === 'done' ? t('move.stepConnectDone') : connectShown === 'waiting' ? t('move.stepConnectWaiting') : t('move.stepConnectRunning')}
          // Yuna 05:39Z: ②'s own word — «아직 연결하고 있어요», never «준비» for a name ① just called ready
          detail={move.stillPreparing.length ? (() => { const g = group(move.stillPreparing); return t('move.stillConnecting', { names: g.text, josa: pickEunNeunJosa(g.last), count: g.count }); })() : null}
          detailTestId={move.stillPreparing.length ? 'setup-still-preparing' : undefined} />
      </ol>
      {move.startFailed.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-start-failed">
          {move.startFailed.map((f) => {
            const runtime = f.runtime ? RUNTIME[f.runtime] : null;
            const rt = runtime ? { runtime, eulReul: pickEulReulJosa(runtime), iGa: pickIGaJosa(runtime) } : null;
            const line = f.line === 'sessionLimit' ? (f.limit ? t('startFailed.sessionLimit', { n: f.limit }) : t('startFailed.sessionLimitNoN'))
              : f.line === 'runtimeMissing' ? (rt ? t('startFailed.runtimeMissing', rt) : t('startFailed.unknown'))
              : f.line === 'runtimeDidNotStart' ? (rt ? t('startFailed.runtimeDidNotStart', rt) : t('startFailed.unknown'))
              : f.line === 'credentials' ? t('startFailed.credentials')
              : f.line === 'keyUnreadable' ? t('startFailed.keyUnreadable')
              : f.line === 'notConnected' ? t('startFailed.notConnected')
              : t('startFailed.unknown');
            return (
              <div key={f.memberId} data-testid="setup-agent-start-failed-row" data-line={f.line}>
                <p>{t('startFailed.titleBare', { role: f.name, josa: pickEulReulJosa(f.name) })}</p>
                <p className="text-muted-foreground">{line}</p>
              </div>
            );
          })}
          <p className="text-muted-foreground">{t('startFailed.where')}</p>
        </div>
      ) : null}
      {move.stopped ? (
        <div className="flex flex-col gap-1 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-stopped">
          <p>{(() => { const g = group(move.stopped.names); return t('stoppedBare', { roles: g.text, josa: pickIGaJosa(g.last), count: g.count }); })()}</p>
          {move.stopped.claude ? <p>{t('stoppedTrust')}</p> : null}
        </div>
      ) : null}
      {move.notConnected ? (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" role="status" data-testid="setup-agent-not-connected">
          <p>{t('notConnected.blockTitleBare', { roles: move.notConnected.names.join(' · ') })}</p>
          <p className="text-muted-foreground">{t(move.notConnected.claude ? 'notConnected.bodyClaude' : 'notConnected.bodyOther')}</p>
          <div><Button variant="outline" size="sm" onClick={onRetry}>{t('notConnected.action')}</Button></div>
        </div>
      ) : null}
      <footer className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2" data-testid="setup-way-out">
          <Button asChild><a href={todayHref}>{t('goToday')}</a></Button>
        </div>
        <p className="text-xs text-muted-foreground">{done ? t('move.doneNote') : t('move.runningNote')}</p>
      </footer>
      {/* story 4670 AC1: the usual new-customer road is a move — the phone's way in (QR · [폰 페어링 열기] · the remote-control [켜기]) is
          there too, and the «아래 카드에서 다시 켤 수 있어요» line points at it */}
      {move.settled ? <PhoneHandoffCard isAdmin={isAdmin} app={app} /> : null}
    </Card>
  );
}

function Step({ state, label, detail, paused = false, detailTestId, children }: { state: StepShown; label: string; detail: string | null; paused?: boolean; detailTestId?: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3" data-state={state} data-paused={paused && state !== 'done' ? 'true' : undefined}>
      {state === 'done'
        ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        : paused || state === 'waiting'
          ? <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground" data-testid={detailTestId}>{detail}</span> : null}
        {children}
      </span>
    </li>
  );
}
