'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Check, Circle, Info, Loader2 } from 'lucide-react';
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
import { endsWithAgentWord, forgetActiveSetup, rememberActiveSetup, setupPollDelayMs, setupProgress, stepsShown, SETUP_STATUS_POLL_MS, type DesktopRuntime, type SetupStatus, type StepShown } from '@/lib/desktop-setup';
import { Failure, ToolsNotConnected } from './desktop-setup';

/**
 * «시작» 뒤 진행 표시(유나 시안 v13 · PO 12:25Z): 설정 상태 조회(4826)를 2초마다 읽어 세 단계로. 조회는 setupProgress()의
 * settled가 참이 되면 멈춘다(story 4464): 막힘 · 만료, 또는 첫 결과 뒤 모든 에이전트가 정해짐(붙음 · 시작 실패 · 멈춤 · 문턱 넘긴
 * 안 붙음 = ⑦ 블록). 설정 id가 없으면(옛 앱) 임시 한 장만.
 */
export function SetupProgressView({ setupId, recipeName }: { setupId: string | null; recipeName: string }) {
  const t = useTranslations('desktop.setup');
  const locale = useLocale();
  const tOrg = useTranslations('organization');
  const tPreset = useTranslations('recipePreset');
  const { orgId, orgMemberships, currentProjectSlug, navV3Flags } = useDashboardContext();
  const flatHref = useFlatHref();
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
      if (s.signals.first_result_at || s.signals.blocked || s.state === 'not_handed_over') forgetActiveSetup();
      else rememberActiveSetup(setupId);
      const at = Date.now();
      setSnap((prev) => ({ status: s, at, handedOverSeenAt: prev?.handedOverSeenAt ?? (s.state === 'handed_over' ? at : null) }));
    } catch { /* 연결이 잠깐 끊겨도 다음 판에 다시 */ }
  }, [setupId]);

  const status = snap?.status ?? null;
  const progress = snap ? setupProgress(snap.status, snap.at, snap.handedOverSeenAt) : null;
  // story 4464 — keep reading until every agent is in (PO 12:04Z: also while a block waits for the person — once they act and the
  // agent connects, the block goes); after 2 minutes of such waiting, every 10 s instead of 2
  const done = !!progress && progress.settled;
  useEffect(() => { stopped.current = done; }, [done]);
  const delay = progress && status ? setupPollDelayMs(progress, status.signals.first_result_at, snap!.at) : SETUP_STATUS_POLL_MS;

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

  if (!progress || !status) {
    return <Card className="break-keep p-6"><h1 className="text-lg font-semibold">{t('startedTitle')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p></Card>;
  }
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
