'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { NowFace } from './now-face';
import { LoopFace } from './loop-face';
import { WorkforceFace } from './workforce-face';

// story ded31cb3(S1)+6b707960(S2)+09fa254e(S3)+64b9a879(우아함 심화) — 조직 브리핑 셸. 목업
// Frame A 배치 1:1: ①지금(hero·상단·폭 전체) → ②루프|③워크포스(2단·하단, lg 미만 스택 —
// GNB lg:hidden과 일치, md 사용 금지).
// 64b9a879: first-touch 온기 greeting 추가 — 로그인 직후 첫 화면=조직 OS 정체성 접점이라는
// 근거가 이번 스토리로 명시됐다(이전 "근거 없는 장식이라 생략" 판단은 그 근거가 없던 시점 것 —
// no-fiction 판단 자체는 유지, 근거가 새로 생겨 뒤집힌 것). userName 없으면 기존 정적 타이틀로
// 안전하게 폴백(빈 이름+"님" 어색함 방지).
// 3면 순차 fade-in stagger(lagom — clutter 추가 아닌 절제된 진입 리듬).

function FaceSkeletonPanel({ title, subject }: { title: string; subject: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-[11px] text-muted-foreground">{subject}</span>
      </div>
      <div className="space-y-3" aria-hidden="true">
        <div className="space-y-1.5">
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div className="h-2 w-16 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
          <div className="h-2 w-20 animate-pulse rounded-full bg-muted" />
        </div>
      </div>
    </div>
  );
}

export function OrgBriefingShell() {
  const t = useTranslations('orgBriefing');
  const { projectId, userName } = useDashboardContext();
  // story #2212 — proxy.ts가 "프로젝트 미확定" 404 대신 여기로 next=<원 목적지>를 들고 보낸
  // 경우, 위 프로젝트 스위처(사이드바/탑바 칩)로 프로젝트를 고르라는 안내를 보여준다. 실제
  // 복귀는 use-unified-switcher.ts의 switchProject/switchOrgAndProject가 이 next를 읽어 처리.
  //
  // 유나양 카피 판정(2026-07-27) — 배너 문구는 상황이 둘이라 조건부다. "이 화면이
  // 활성화됩니다"류 시스템어는 둘 다 안 쓴다:
  //   next 있음(#2212 리다이렉트로 옴)  → 원래 가려던 화면이 있었음을 인정하고 그리로
  //                                       돌려보낸다는 문장("왜 갑자기 여기 왔지"에 답함)
  //   next 없음(그냥 방문·프로젝트 아예 없음) → 여기(org-briefing) 자체에 현황이 뜬다는 문장
  //   둘 다 아님(next 없음 + 프로젝트 있음) → 평범한 방문이라 배너 자체가 불필요(소음)
  const searchParams = useSearchParams();
  const nextTarget = searchParams.get('next');
  const showProjectBanner = !!nextTarget || !projectId;
  const projectBannerText = nextTarget ? t('projectRequiredBannerNext') : t('projectRequiredBannerEmpty');

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
      {showProjectBanner && (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-foreground" role="status">
          {projectBannerText}
        </div>
      )}
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {userName ? t('greeting', { name: userName }) : t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-1 duration-300">
        <NowFace />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-300 [animation-delay:75ms] [animation-fill-mode:backwards]">
          {projectId ? <LoopFace projectId={projectId} /> : <FaceSkeletonPanel title={t('loopTitle')} subject={t('loopSubject')} />}
        </div>
        <div className="animate-in fade-in slide-in-from-bottom-1 duration-300 [animation-delay:150ms] [animation-fill-mode:backwards]">
          {projectId ? <WorkforceFace projectId={projectId} /> : <FaceSkeletonPanel title={t('workforceTitle')} subject={t('workforceSubject')} />}
        </div>
      </div>
    </div>
  );
}
