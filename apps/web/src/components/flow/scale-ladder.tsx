'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { AnchoredPopover, isOutsidePress } from '@/components/shared/anchored-popover';

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
 * story #4888(UI-5 보드 머리 첫 조각, AC3 §4-3 «머리 4겹 → 탭줄 + 필터 한 줄») — 폭 ≥1024에서 따로 그리던
 * 카드열(이름+질문 5칸, 120.5px)을 없애고 **칩 한 줄(34.5px)을 모든 폭에서** 그린다. 질문 문구는 빠지지 않고
 * 칩의 `title`(마우스를 올리면 뜨는 설명)로 옮겼다 — 이름만으로 «지금 보는 층» 신호는 충분하고, 질문은 필요할 때만 본다.
 * 두 판을 CSS로 가르던 장치(story #4222)는 판이 하나라 필요 없어졌다(서버 출력 = 최종 높이, 흔들림 0).
 *
 * 조건 3건(유나 (a)-final):
 * ① 이동 칸(목표)만 ↗·나머지 렌즈 칸(가설/갈래/스토리)은 ↗ 無, 라벨(렌즈/이동)로 이중 표식.
 * ② 기존 렌즈 세그(가설|갈래|칸반, flow-client.tsx의 3버튼 줄)는 제거 — 이 컴포넌트가 흡수.
 * ③ 매핑은 #3111에서 이미 정정됨(view=list→street/스토리) — 이 스토리는 그 위에 클릭만 얹는다.
 */
export const LADDER_LEVELS = ['earth', 'continent', 'city', 'street', 'building'] as const;
export type LadderLevel = (typeof LADDER_LEVELS)[number];

type LensView = 'hypothesis' | 'flow' | 'list';

// story #3130(유나 SSOT doc jakup-reserved-signal-final-spec-3731984e, 2026-08-27) — 「작업」
// 칸의 dead(클릭 불가·«고장»으로 읽힘)를 reserved(클릭 가능·안내 팝오버)로 전환. `dead`
// kind는 타입에서 제거하지 않는다(doc: "추가" — 향후 다른 kind가 필요할 자리로 존치).
type RungBehavior = { kind: 'lens'; view: LensView } | { kind: 'move' } | { kind: 'dead' } | { kind: 'reserved' };

const RUNG_BEHAVIOR: Record<LadderLevel, RungBehavior> = {
  earth: { kind: 'lens', view: 'hypothesis' },
  continent: { kind: 'move' },
  city: { kind: 'lens', view: 'flow' },
  street: { kind: 'lens', view: 'list' },
  building: { kind: 'reserved' },
};

export function ScaleLadder({ activeLevel = 'earth' }: { activeLevel?: LadderLevel }) {
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

  // story #3130 — reserved rung 클릭 시 안내 팝오버. 한 번에 하나만 열린다(래더 전체에 예약
  // rung이 여럿이어도 상태 하나 공유 — 오늘은 building 뿐이라 실질적으로 무관하지만 향후
  // 확장 대비). ref는 열린 rung의 wrapper에만 붙는다 — 트리거 버튼 클릭이 "바깥 클릭"으로
  // 오인돼 즉시 재닫히는 것을 막는다(sender-profile-popover.tsx와 동형 관행).
  const [openReservedLevel, setOpenReservedLevel] = useState<LadderLevel | null>(null);
  const reservedWrapperRef = useRef<HTMLDivElement>(null);
  // story #4349 — 안내 팝오버는 부모(칩 줄 overflow-x-auto · 사다리 overflow-hidden) 밖 body로 포털된다(AnchoredPopover).
  // 그래서 트리거 wrapper의 자손이 아니다 → 바깥 클릭 판정에서 팝오버 요소도 «안»으로 센다.
  const infoPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openReservedLevel === null) return;
    const onPointerDown = (e: PointerEvent) => {
      // 포털된 안내 팝오버(infoPopoverRef)는 body 직속 — 공용 규칙이 «안»으로 센다.
      if (isOutsidePress(reservedWrapperRef.current, e.target)) setOpenReservedLevel(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenReservedLevel(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openReservedLevel]);

  // story #3043(PO+유나 IA 확定 ⓐ) · story #4888 — 래더는 보드의 렌즈/필터(지금 보는 층 표시)일 뿐이라 칩 한 줄로 그린다.
  // 질문 문구(ladderQuestion_*)는 눈에는 안 보이고 — 마우스는 칩 `title`로, 화면 읽기 프로그램은 칩마다 이어진 sr-only 설명(aria-describedby)으로 읽는다.
  //
  // story #3112 — 칩도 클릭 배선된다(모바일은 옛 3버튼 세그가 없어 이 칩 줄이 유일한 렌즈 전환 경로).
  return (
    <div>
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border bg-card px-1.5 py-1" data-testid="scale-ladder-chips">
        {LADDER_LEVELS.map((level) => {
          const active = level === activeLevel;
          const behavior = RUNG_BEHAVIOR[level];
          const question = t(`ladderQuestion_${level}`);
          const questionId = `ladder-question-${level}`;
          const chipClassName = cn(
            // story #4888 — 폰(터치) 누름 영역 44: 칩 줄이 보드 머리로 들어와 같은 줄의 단추들(44)과 높이가 갈렸다. 터치에서만 높이를 올린다(마우스는 34 그대로).
            'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-editorial-meta font-medium transition touch:min-h-11',
            active ? 'bg-brand/10 text-brand-text' : 'text-muted-foreground',
            behavior.kind === 'dead' && 'cursor-not-allowed opacity-60',
            behavior.kind === 'reserved' && 'cursor-help',
          );
          if (behavior.kind === 'lens') {
            return (
              <button
                key={level}
                type="button"
                title={question}
                aria-describedby={questionId}
                aria-current={active ? 'true' : undefined}
                onClick={() => goToLens(behavior.view)}
                className={chipClassName}
              >
                {t(`ladderName_${level}`)}
              </button>
            );
          }
          if (behavior.kind === 'move') {
            // 이동 칸(목표)만 ↗ — 렌즈 칸은 같은 화면 안 전환이라 ↗ 없음(조건①).
            return (
              <Link key={level} href={goalsHref} title={question} aria-describedby={questionId} className={chipClassName}>
                {t(`ladderName_${level}`)}
                <span aria-hidden="true" className="ml-0.5 font-bold text-brand">↗</span>
              </Link>
            );
          }
          if (behavior.kind === 'reserved') {
            // (i)+클릭 팝오버로 "예약/안내"임을 전달한다. 터치 기기는 hover가 없어 이 클릭 팝오버가 유일한 안내 경로다(doc 명시).
            const open = openReservedLevel === level;
            const infoId = `ladder-reserved-info-${level}`;
            return (
              <div key={level} ref={open ? reservedWrapperRef : undefined} className="relative shrink-0">
                <button
                  type="button"
                  title={question}
                  aria-describedby={open ? `${questionId} ${infoId}` : questionId}
                  onClick={() => setOpenReservedLevel(open ? null : level)}
                  className={cn(chipClassName, 'inline-flex items-center gap-1')}
                >
                  {t(`ladderName_${level}`)}
                  <Info aria-hidden="true" className="size-3" />
                </button>
                {/* story #4349 — 칩 줄(overflow-x-auto · 세로도 auto)이 absolute 팝오버를 통째로 잘랐다 → body로 포털(칩 줄 가로 스크롤은 그대로). */}
                {open && (
                  <AnchoredPopover
                    anchorRef={reservedWrapperRef}
                    popoverRef={infoPopoverRef}
                    id={infoId}
                    role="tooltip"
                    data-dropdown-panel="scale-ladder-info"
                    className="z-50 w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-[var(--elev-overlay)]"
                  >
                    {t('ladderReservedInfo')}
                  </AnchoredPopover>
                )}
              </div>
            );
          }
          return (
            <span key={level} title={question} aria-describedby={questionId} className={chipClassName} aria-disabled="true">
              {t(`ladderName_${level}`)}
            </span>
          );
        })}
      </div>
      {/* story #4888 — 질문 문구는 화면에서 빠졌지만(설계) 지워진 게 아니다: 칩마다 aria-describedby로 이어진 sr-only 글이 접근 가능한 설명이다
          (title은 마우스 올림에만 보이고 화면 읽기 프로그램이 일정하게 안 읽는다). 칩 «안»이 아니라 옆에 둔다 — 안에 두면 칩의 접근 가능한 이름이 «가설 무엇을 검증하는가»로 길어진다. */}
      <div className="sr-only" data-testid="scale-ladder-questions">
        {LADDER_LEVELS.map((level) => (
          <span key={level} id={`ladder-question-${level}`}>
            {t(`ladderQuestion_${level}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
