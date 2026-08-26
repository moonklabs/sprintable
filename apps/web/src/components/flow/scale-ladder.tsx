'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * story #2531(E-FLOW-V4 S1)에서 지구층 전용으로 태어났다가, story #2535(S5)에서 다른 층
 * (갈래·목록)에도 재사용하도록 분리됐다 — «지금 보는 층 = 묻는 질문 전환»(doc
 * flow-board-v4-hypothesis-scale §2)을 어느 뷰에서도 같은 자리에서 보여준다.
 *
 * 유나 design 재규격(2026-08-09, prod 前 정정) — 지구/대륙/도시/거리/건물 같은 «행성 은유»
 * legend 줄을 뺐다(사용자에게 의미 없는 이름표라는 지적). 각 rung은 이제 이름(가설/목표/
 * 갈래/스토리/작업)+질문(무엇을 검증하는가…) 둘만 — active 강조는 그 이름 쪽으로 옮겨졌다.
 *
 * story #3112(Board IA·D0(a), 선생님 승인 2026-08-26·카드 520beb8b·픽셀 규격 artifact
 * c1f89cb5 v3) — «탭처럼 보이는데 클릭 안 됨»(선생님 재지적 2회) → «축척 네비게이터»로
 * 승격. 클릭 배선을 이 컴포넌트 레벨에 둔 이유: 렌더 사이트가 2곳(flow-client.tsx·
 * hypothesis-earth-layer.tsx)인데 둘 다 같은 `/flow` 라우트 트리 안이라 pathname에서
 * ws/proj 세그먼트를 그대로 뽑아 쓸 수 있다 — 두 호출부에 wsSlug/projSlug를 새로 꿰지
 * 않고 여기 한 곳에서만 배선해도 양쪽이 함께 동작한다(호출부 prop 계약 무변경).
 *
 * 조건 3건(유나 (a)-final):
 * ① 이동 칸(목표)만 ↗·나머지 렌즈 칸(가설/갈래/스토리)은 ↗ 無, 라벨(렌즈/이동)로 이중 표식.
 * ② 기존 렌즈 세그(가설|갈래|칸반, flow-client.tsx의 3버튼 줄)는 제거 — 이 컴포넌트가 흡수.
 * ③ 매핑은 #3111에서 이미 정정됨(view=list→street/스토리) — 이 스토리는 그 위에 클릭만 얹는다.
 */
export const LADDER_LEVELS = ['earth', 'continent', 'city', 'street', 'building'] as const;
export type LadderLevel = (typeof LADDER_LEVELS)[number];

type LensView = 'hypothesis' | 'flow' | 'list';

type RungBehavior = { kind: 'lens'; view: LensView } | { kind: 'move' } | { kind: 'dead' };

const RUNG_BEHAVIOR: Record<LadderLevel, RungBehavior> = {
  earth: { kind: 'lens', view: 'hypothesis' },
  continent: { kind: 'move' },
  city: { kind: 'lens', view: 'flow' },
  street: { kind: 'lens', view: 'list' },
  building: { kind: 'dead' },
};

export function ScaleLadder({ activeLevel = 'earth', compact = false }: { activeLevel?: LadderLevel; compact?: boolean }) {
  const t = useTranslations('flow');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // pathname은 항상 `/${wsSlug}/${projSlug}/flow`(두 렌더 사이트 모두 이 라우트 트리
  // 안이라서) — 앞 두 세그먼트만 취해 basePath로 재사용한다.
  const [wsSlug, projSlug] = pathname.split('/').filter(Boolean);
  const flowPath = `/${wsSlug}/${projSlug}/flow`;
  const goalsHref = `/${wsSlug}/${projSlug}/goals`;

  // flow-client.tsx의 옛 setView와 동일 계약(다른 파라미터는 손대지 않는다·list=기본값이라
  // view 파라미터 자체를 지운다) — 그 3버튼 세그를 이 컴포넌트가 그대로 흡수한다.
  const goToLens = (view: LensView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (view === 'list') params.delete('view');
    else params.set('view', view);
    const qs = params.toString();
    router.push(`${flowPath}${qs ? `?${qs}` : ''}`);
  };

  function rungLabel(level: LadderLevel): string {
    const behavior = RUNG_BEHAVIOR[level];
    if (behavior.kind === 'move') return t('ladderLabelMove');
    if (behavior.kind === 'dead') return t('ladderLabelPending');
    return t('ladderLabelLens');
  }

  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — <lg에서 이 카드열(이름+질문 5칸, py-2.5)이
  // 「주」처럼 보여 보드(칸반) 콘텐츠를 아래로 밀어냈다(유나 실측). 래더는 원래 역할이 보드의
  // 렌즈/필터(지금 보는 층 표시)일 뿐이라 — 칩열로 낮춘다. 질문 문구(ladderQuestion_*)는
  // 이 압축판에서 뺀다(공간 예산 안에서 이름만으로도 "지금 보는 층" 신호는 충분 — active
  // 강조·순서 자체가 이미 그 정보를 나른다).
  //
  // story #3112 — compact도 전체판과 동일하게 클릭 배선된다(모바일은 옛 3버튼 세그가 아예
  // 없어져 이 칩열이 유일한 렌즈 전환 경로가 된다 — compact만 read-only로 남기면 모바일에서
  // 렌즈 전환 자체가 증발한다).
  if (compact) {
    return (
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card px-1.5 py-1">
        {LADDER_LEVELS.map((level) => {
          const active = level === activeLevel;
          const behavior = RUNG_BEHAVIOR[level];
          const chipClassName = cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium transition',
            active ? 'bg-brand/10 text-brand' : 'text-muted-foreground',
            behavior.kind === 'dead' && 'cursor-not-allowed opacity-60',
          );
          if (behavior.kind === 'lens') {
            return (
              <button key={level} type="button" onClick={() => goToLens(behavior.view)} className={chipClassName}>
                {t(`ladderName_${level}`)}
              </button>
            );
          }
          if (behavior.kind === 'move') {
            return (
              <Link key={level} href={goalsHref} className={chipClassName}>
                {t(`ladderName_${level}`)}
              </Link>
            );
          }
          return (
            <span key={level} className={chipClassName} aria-disabled="true">
              {t(`ladderName_${level}`)}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex overflow-hidden rounded-xl border border-border bg-card">
      {LADDER_LEVELS.map((level) => {
        const active = level === activeLevel;
        const behavior = RUNG_BEHAVIOR[level];
        const rungClassName = cn(
          'relative flex-1 border-r border-border px-3 py-2.5 pb-6 text-left last:border-r-0',
          active && 'bg-gradient-to-b from-brand/10 to-transparent',
          behavior.kind === 'dead' && 'cursor-not-allowed bg-muted/40',
          behavior.kind !== 'dead' && 'cursor-pointer hover:bg-muted/30',
        );
        const inner = (
          <>
            <div className={cn('text-sm font-semibold text-foreground', active && 'text-brand', behavior.kind === 'dead' && 'text-muted-foreground')}>
              {t(`ladderName_${level}`)}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{t(`ladderQuestion_${level}`)}</div>
            <span
              aria-hidden="true"
              className={cn('absolute top-2.5 right-2.5 size-2 rounded-full bg-border', active && 'bg-brand')}
            />
            {behavior.kind === 'move' ? (
              <span aria-hidden="true" className="absolute right-2.5 bottom-2 text-xs font-bold text-brand">↗</span>
            ) : null}
            <span
              className={cn(
                'absolute bottom-2 left-3 text-[9.5px] font-semibold tracking-wide uppercase',
                behavior.kind === 'dead' ? 'text-muted-foreground/60' : behavior.kind === 'move' ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              {rungLabel(level)}
            </span>
          </>
        );

        if (behavior.kind === 'lens') {
          return (
            <button key={level} type="button" onClick={() => goToLens(behavior.view)} className={rungClassName}>
              {inner}
            </button>
          );
        }
        if (behavior.kind === 'move') {
          return (
            <Link key={level} href={goalsHref} className={rungClassName}>
              {inner}
            </Link>
          );
        }
        return (
          <div key={level} className={rungClassName} aria-disabled="true">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
