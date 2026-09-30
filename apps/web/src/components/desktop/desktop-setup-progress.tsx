'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { pickEulReulJosa } from '@/lib/korean-particle';
import { presetName } from '@/lib/platform-preset-copy';
import { stageRoleLabel } from '@/lib/stage-role';
import { storyBoardUrl } from '@/lib/entity-project-url';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { forgetActiveSetup, rememberActiveSetup, setupProgress, SETUP_STATUS_POLL_MS, type DesktopRuntime, type SetupStatus, type StepState } from '@/lib/desktop-setup';
import { Failure, ToolsNotConnected } from './desktop-setup';

/**
 * «시작» 뒤 진행 표시(유나 시안 v13 · PO 12:25Z): 설정 상태 조회(4826)를 2초마다 읽어 세 단계로. 결과가 나오거나 화면이
 * 실패(⑥ · ④)로 바뀌면 조회를 멈춘다. 설정 id가 없으면(옛 앱) 임시 한 장만.
 */
export function SetupProgressView({ setupId, recipeName }: { setupId: string | null; recipeName: string }) {
  const t = useTranslations('desktop.setup');
  const tOrg = useTranslations('organization');
  const tPreset = useTranslations('recipePreset');
  const { orgId, orgMemberships, currentProjectSlug } = useDashboardContext();
  const flatHref = useFlatHref();
  // one reading: the status, when it was read, and when this page first saw «handed_over» (the status carries no such time)
  const [snap, setSnap] = useState<{ status: SetupStatus; at: number; handedOverSeenAt: number | null } | null>(null);
  const stopped = useRef(false);

  const poll = useCallback(async () => {
    if (!setupId) return;
    try {
      const res = await fetchWithAuth(`/api/desktop/setups/${setupId}`);
      if (!res.ok) return; // 한 번 못 읽으면 다음 판에 다시(화면은 그대로)
      const body = (await res.json()) as SetupStatus | { data?: SetupStatus };
      const s = 'signals' in body ? body : body.data ?? null;
      if (!s) return;
      // «설정 진행 중» 표시(문서 열림 셈 · AC2): 흐름이 끝나면 지우고, 아니면 읽을 때마다 새로 적는다(PO 13:00Z)
      if (s.signals.first_result_at || s.signals.blocked || s.state === 'not_handed_over') forgetActiveSetup();
      else rememberActiveSetup(setupId);
      const at = Date.now();
      setSnap((prev) => ({ status: s, at, handedOverSeenAt: prev?.handedOverSeenAt ?? (s.state === 'handed_over' ? at : null) }));
    } catch { /* 연결이 잠깐 끊겨도 다음 판에 다시 */ }
  }, [setupId]);

  const status = snap?.status ?? null;
  const progress = snap ? setupProgress(snap.status, snap.at, snap.handedOverSeenAt) : null;
  const done = !!progress && (progress.result === 'done' || progress.blocked || progress.expired);
  useEffect(() => { stopped.current = done; }, [done]);

  useEffect(() => {
    if (!setupId) return;
    // the first reading right away (on the next task — no state change inside the effect itself), then every 2 s
    const first = window.setTimeout(() => void poll(), 0);
    const timer = window.setInterval(() => { if (!stopped.current) void poll(); }, SETUP_STATUS_POLL_MS);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [setupId, poll]);

  if (!progress || !status) {
    return <Card className="break-keep p-6"><h1 className="text-lg font-semibold">{t('startedTitle')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p></Card>;
  }
  if (progress.blocked) return <Failure failure="managed" />;
  if (progress.expired) return <Failure failure="expired" />;
  // the folder-trust question is Claude Code's (Codex does not ask it) — Yuna v24 · PO 11:19Z
  const claude = status.members.some((m) => m.kind === 'agent' && m.runtime === 'claude');
  if (progress.notConnected) return <ToolsNotConnected onRetry={() => void poll()} claude={claude} />;

  const role = (r: string) => stageRoleLabel(r, tOrg);
  const RUNTIME: Record<DesktopRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };
  // one name in one flow (PO 10:39Z ①): the recipe as the list names it — a platform preset by its translation, not the stored
  // name — from the server's recipe (also when the page is opened again without the list's name)
  const task = status.recipe ? presetName(status.recipe, tPreset) : (recipeName || status.recipe_name || '');
  const orgSlug = orgMemberships?.find((o) => o.orgId === orgId)?.orgSlug;
  const resultHref = status.work_item_id && orgSlug && currentProjectSlug
    ? storyBoardUrl(orgSlug, currentProjectSlug, status.work_item_id)
    : status.work_item_id ? flatHref(`/flow?story=${status.work_item_id}`) : null;
  const resultReady = progress.result === 'done' && !!resultHref;

  return (
    <Card className="break-keep flex flex-col gap-4 p-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')}{task ? ` · ${task}` : ''}</p>
        <h1 className="text-lg font-semibold">{progress.result === 'done' ? t('startedDoneTitle') : t('startedTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p>
      </header>
      <ol className="flex flex-col gap-3" aria-live="polite">
        <Step state={progress.ready} label={progress.ready === 'done' ? t('stepReadyDone') : t('stepReadyRunning')}
          detail={progress.ready === 'done' ? progress.pairs.map((p) => `${role(p.role)} · ${RUNTIME[p.runtime]}`).join(', ') : null} />
        {progress.workdirFallback ? (
          <li className="ml-7 flex gap-2 text-xs text-muted-foreground" data-testid="setup-workdir-fallback">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{t('workdirFallback', { recipe: task })}
          </li>
        ) : null}
        <Step state={progress.handed} label={progress.handed === 'done' ? t('stepHandedDone') : t('stepHandedRunning')}
          detail={progress.handed === 'running' && task && progress.firstAgentRole
            ? t('stepHandedDetail', { task, josa: pickEulReulJosa(task), role: role(progress.firstAgentRole) }) : null} />
        {progress.trustHint && claude ? (
          <li className="ml-7 flex gap-2 rounded-md bg-muted p-2 text-xs" data-testid="setup-trust-hint">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{t('trustHint')}
          </li>
        ) : null}
        <Step state={progress.result} label={progress.result === 'done' ? t('stepResultDone') : t('stepResultRunning')} detail={null} />
      </ol>
      <footer className="flex flex-col gap-1">
        {resultReady
          ? <div><Button asChild><a href={resultHref!}>{t('seeResult')}</a></Button></div>
          : <div><Button disabled>{t('seeResult')}</Button></div>}
        {!resultReady ? <p className="text-xs text-muted-foreground">{t('seeResultReason')}</p> : null}
      </footer>
    </Card>
  );
}

function Step({ state, label, detail }: { state: StepState; label: string; detail: string | null }) {
  return (
    <li className="flex gap-3" data-state={state}>
      {state === 'done'
        ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}
