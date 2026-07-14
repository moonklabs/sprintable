'use client';

import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { NowFace } from './now-face';
import { LoopFace } from './loop-face';
import { WorkforceFace } from './workforce-face';

// story ded31cb3(S1)+6b707960(S2)+09fa254e(S3) — 조직 브리핑 셸. 목업 Frame A 배치 1:1: ①지금
// (hero·상단·폭 전체) → ②루프|③워크포스(2단·하단, lg 미만 스택 — GNB lg:hidden과 일치, md 사용 금지).
// 유나 보강(conv 32b8cff9 11:42:42): 루프/워크포스는 S1에서 레이아웃 골격만 확定 — 자리 이동 없이
// 데이터만 증분 장착(루프=S2, 워크포스=이번). 헤더 인사말/시간대 카피는 근거 없는 장식이라 생략(no-fiction).

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
  const { projectId } = useDashboardContext();

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <NowFace />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {projectId ? <LoopFace projectId={projectId} /> : <FaceSkeletonPanel title={t('loopTitle')} subject={t('loopSubject')} />}
        {projectId ? <WorkforceFace projectId={projectId} /> : <FaceSkeletonPanel title={t('workforceTitle')} subject={t('workforceSubject')} />}
      </div>
    </div>
  );
}
