'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ViewerDate } from '@/components/viewer-time-zone';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PublishedSection } from './today-sections';
import { CountBadge } from '@/components/ds/count-badge';
import { ActivationChecklistBanner } from '@/components/dashboard/activation-checklist-banner';
import { HomeScreen } from '@/components/home/home-screen';
import { useHomeModel } from '@/components/home/home-model-provider';
import { AgentStateSection } from './agent-state-section';
import { InstructionStrip } from './instruction-strip';
import { TodayPairCard } from './today-pair-card';

// story #3831(UX-v3·FE 3·오늘, 페드루 PO 確定 2026-09-13) — 옛 조직 브리핑(NowFace·
// LoopFace·WorkforceFace, 각자 다른 BFF 4종 조합)을 시안 v3(오늘 1caf61fe)로 흡수한다.
// 수의 출처는 story #3823 `GET /api/v2/today` 단 하나(자체 집계 0) — 3구역(사람 손이
// 필요한 일·에이전트가 하는 일·오늘 나간 것) + 하단 지시 한 줄. §② 흡수 지도대로
// 실험실/워크포스는 이 화면에서 완전히 걷힌다(다른 자리로 흡수 — 삭제 아님).
//
// project 배너: 옛 로직은 `!projectId`(로컬 LoopFace/WorkforceFace가 project 없인 못 그려
// 스켈레톤을 대신 그리던 시절)도 배너 조건이었다 — today route는 org 스코프뿐이라(project_id
// 파라미터 자체가 없다) 그 조건은 이제 거짓이 된다(项目 없어도 내용은 뜬다). `next`(#2212
// 리다이렉트 복귀 안내)만 남긴다.

export function OrgBriefingShell() {
  const t = useTranslations('orgBriefing');
  const tc = useTranslations('common');
  // today route는 org 스코프뿐 — 내용은 project를 안 쓴다. project는 오직 «복귀 안내 띠»(아래)만 본다.
  const { projectId, projectMemberships } = useDashboardContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nextTarget = searchParams.get('next');
  // story 4773 (AC2) — «Pick a project and we'll take you back…» is true only for a person who has NOT picked a project and has one to pick. It was drawn for any `?next=` — also the retry mark the
  // session restore puts there (`/org-briefing?next=/glance?_prRetry=1`, AC8 lap 10-24) with the project already chosen (`?p=` on the page, every flat link carrying it): a line that sent the person
  // looking for a choice already made. With no project to pick (none yet) «pick» cannot be done either — Chats says «no project yet» for that.
  const showPickBanner = Boolean(nextTarget) && !projectId && projectMemberships.length > 0;
  // story #4888 — the home reads the SAME model the navigation bar's badge reads (components/home/home-model-provider)
  const { model, sources, loadError, partial, retry } = useHomeModel();
  const th = useTranslations('home');

  // story #3831 후속(페드루 PO 確定, 2026-09-13 14:22Z) — `?focus=compose` 딥링크(컴패니언
  // 단축키, story #3832)는 소비 뒤 URL에서 지운다(뒤로가기·새로고침마다 재포커스되면
  // 사용자가 타이핑 중이던 걸 매번 뺏는 결함이 된다).
  const shouldAutoFocusInstruction = searchParams.get('focus') === 'compose';
  useEffect(() => {
    if (!shouldAutoFocusInstruction) return;
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회만(그 뒤 focus는 이미 지워짐).
  }, []);

  // story #4443 PR2 — «today» is the viewer's today (ViewerDate below: their zone · held while unknown)
  const today = new Date();

  return (
    // story #4277(민 기기 #1) — 셸 본문 열(flex-col) 안에서 mx-auto(자동 여백)가 stretch를 꺼 이 뿌리가 «내용 폭»으로 줄었다 → 긴 제목(한 줄
    // 말줄임 · nowrap)의 폭이 그대로 뿌리 폭(최대 max-w-4xl = 896px)이 돼 402폭에서 가로로 밀어야 «승인하고 서명» · «보내기»가 보였다.
    // w-full로 열 폭을 채우고(말줄임이 제 폭 안에서 동작) mx-auto는 넓은 화면 가운데 정렬만 맡는다.
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 lg:p-6">
      {/* story 4773 (AC3, PO 10-25) — the top band: the phone app, a phone paired with nothing → one line + [컴퓨터와 페어링]. The instruction box below stays where hands expect it (4762 AC3: Send clear of the support button). */}
      <TodayPairCard />
      {showPickBanner ? (
        <Alert role="status">
          <AlertDescription>{t('projectRequiredBannerNext')}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground"><ViewerDate value={today} options={{ month: 'long', day: 'numeric', weekday: 'long' }} /></p>
        </div>
        {model && model.badge > 0 ? (
          // story #4888 — the number is the model's one number: the rows in «내 손이 필요해요» (= the bar's badge)
          <CountBadge kind="needs-hand" label={th('needsHandLabel')} count={model.badge} data-testid="needs-me-header-badge" />
        ) : null}
      </div>

      {/* story #4888 — the start checklist is a card at the top of the home list (it used to stand over /chats and every other page as a band). It stands here, outside the data branch below: it draws its
          own skeleton while it loads, so it does not arrive late and push the list down */}
      <div className="empty:hidden" data-testid="home-checklist-slot">
        <ActivationChecklistBanner placement="home" />
      </div>

      {loadError && !model ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
          <Button size="sm" variant="outline" onClick={retry}>{tc('retry')}</Button>
        </div>
      ) : !model || !sources ? (
        <div className="space-y-3" aria-hidden="true">
          <Card className="h-24 animate-pulse bg-muted/30" />
          <Card className="h-24 animate-pulse bg-muted/30" />
        </div>
      ) : (
        <div className="space-y-6">
          {loadError || partial ? (
            // the last read failed, or part of it could not be read: the list below is what WAS read — said, with a way to read again (never passed off as complete)
            <div role="status" className="flex items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="home-incomplete-notice">
              <span>{loadError ? t('loadErrorTitle') : th('partialNotice')}</span>
              <Button size="sm" variant="outline" onClick={retry}>{tc('retry')}</Button>
            </div>
          ) : null}
          <HomeScreen model={model} sources={sources} partial={partial || loadError} />
          <AgentStateSection />
          <PublishedSection published={sources.snapshot.published} usage={sources.snapshot.usage} />
        </div>
      )}

      {/* 페드루 PO CHANGES(2026-09-14 00:58Z, PR #4256) — 1440×900에서 이 입력이 스크롤 없이는 안 보이던 결함(「오늘」의 주 액션이라 접혀선 안 된다) → 본문 pane(dashboard-shell.tsx의 overflow-y-auto
          스크롤 조상) 하단에 sticky. 4906 셋째 바퀴 — 띠는 pane의 «바닥 가장자리»까지 닿는 불투명 면(instruction-strip.tsx). */}
      <InstructionStrip autoFocus={shouldAutoFocusInstruction} />
    </div>
  );
}
