import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * story #2879(S1b) — PageHeader ↔ top-bar(+slot) 역할 정리(스펙 §2, doc
 * ui-overhaul-s1-primitives-spec 기준).
 *
 * - **top-bar**(`components/nav/top-bar.tsx` + `TopBarSlot`) = 글로벌 chrome 상단 —
 *   브레드크럼/현재 화면명·컨텍스트 칩(조직·프로젝트 전환)·전역 액션(알림·presence 등).
 *   `<1024`에서 특히 "지금 어디에 있는지"를 화면 제목보다 먼저 보여주는 상시 표면이다.
 * - **PageHeader**(이 파일) = 페이지 **본문** 최상단 제목 블록 — 그 화면의 콘텐츠 위계에서
 *   h1을 소유한다. eyebrow(여정/컨텍스트 라벨, 예: 소속 에픽·목표명 — Task→Trust 서사
 *   훅으로 활용 가능)+title+description+actions.
 *
 * **규칙(한 화면에 title을 그리는 표면은 하나만):** top-bar 슬롯의 `title`과 PageHeader의
 * `title`을 같은 화면에서 동시에 쓰지 않는다 — 어느 쪽이 title을 갖는지는 화면 타입으로 정한다.
 *   - **루트/목록형 화면**(보드·목표목록 등 컨텍스트를 "훑는" 화면): top-bar 슬롯이 title을
 *     가진다(현재 관례 — TopBarSlot 소비처 다수). PageHeader는 안 쓰거나 title 없이 actions만.
 *   - **콘텐츠 본문이 두꺼운 상세/도구 화면**(내부 대시보드·상세 패널 등 PageHeader 기존
 *     소비처 2곳): PageHeader가 title을 가진다 — 이런 화면은 보통 top-bar 슬롯을 title 없이
 *     쓰거나 아예 안 쓴다.
 * 새 화면을 만들 때 이 표를 참고해 딱 하나만 고른다(dual-header 방지).
 */
// story #2969 §1.3/§2 C행(doc proofline-system-layer-2969, PR-6) — Display tier(에디토리얼
// 디스플레이 타이포) 적용: font-bold(700)→--font-weight-editorial-heading(820)·
// tracking-tight→-0.02em(§1.3 Display 정의 그대로). ⚠️무게는 유틸리티 클래스가 아니라
// 인라인 style로 건다 — tailwind-merge가 페이스 클래스와 (구)무게 클래스를 같은 충돌군으로
// 오인해 하나를 지우던 전례가 있었다(직접 실측 완료, page-header.test.tsx에 회귀가드).
// §1.4가 이 파일의 "히어로 판"에 proof-cut도 요구하지만, 이 컴포넌트는 현재 배경/패딩이
// 없는 순수 타이포 블록이라(panel이 아님) cut이 보일 표면 자체가 없다 — 유나가 이 요건을
// 철회함(2026-08-23, «page-header는 Display 타이포까지가 끝»).
//
// story #2974 §1(PR-D0) — 페이스(family)를 `font-heading`(=Pretendard 고정)에서
// `font-display`(§1 신규 토큰, D0 초기값도 var(--font-sans)라 시각 변화 0)로 전환. 이
// 파일이 doc §3의 "가장 대표" Display 소비처로 명시된 자리 — 세리프 켜기(D1~)가 실제로
// 이 h1부터 반영되게 하려면 반드시 이 토큰을 경유해야 한다(font-heading으로 남으면 세리프
// 전환에서 이 화면만 빠짐).
const pageHeaderVariants = cva('font-display tracking-[-0.02em] text-foreground', {
  variants: {
    size: {
      page: 'text-2xl md:text-3xl',
      section: 'text-xl',
      compact: 'text-lg',
    },
  },
  defaultVariants: { size: 'page' },
});

export interface PageHeaderProps extends VariantProps<typeof pageHeaderVariants> {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, actions, className, size }: PageHeaderProps) {
  return (
    <section className={cn('flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="space-y-1.5">
        {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{eyebrow}</div> : null}
        <h1
          className={cn(pageHeaderVariants({ size }))}
          style={{ fontWeight: 'var(--font-weight-editorial-heading)' }}
        >
          {title}
        </h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}
