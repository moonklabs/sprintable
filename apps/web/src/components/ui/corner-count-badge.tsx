import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * story #3431(공용, PO 確定 2026-09-05) — 아이콘에 얹는 카운트 오버레이 배지의 유일한
 * 정의. 처음엔 2곳(notification-bell·team-presence-toggle)만 보였으나 그라운딩 중
 * `mobile-tab-bar.tsx`의 chat/approvals 배지가 같은 모양의 3번째 복사본임을 발견 —
 * PO 確定으로 셋 다 접는다(AC2 "복사본을 하나로"가 한 곳을 남기면 반쪽).
 *
 * ⚠️`ui/count-badge.tsx`(story #3049)의 `CountBadge`와 이름·모양·용도 전부 다르다 —
 * 그건 인라인 흐름 안에 앉는 그룹/태그 카운트 칩(예: 「38건」, 엠보스 inset 재질), 이건
 * 아이콘에 절대위치로 얹는 원형 배지(안 읽음/작업중/미결 수). 헷갈리지 않게 이름을 따로 뒀다.
 *
 * 크기는 team-presence-toggle·mobile-tab-bar가 이미 쓰던 10px·h-4·min-w-4를 그대로
 * 채택했다(둘 다 변경 0). bell만 이 스토리로 9px→10px(§AC4, 대비와 별개 축). font는
 * tabular-nums로 통일(bell의 font-mono 폐기) — ui/badge.tsx 자체가 "mono 라벨은
 * 한글서 흐림(2967 교훈)"이라 공유 primitive에 안 넣는 관례를 그대로 따른 것뿐, 라틴
 * 숫자만 싣는 이 배지엔 tabular-nums로 충분하다.
 *
 * ⚠️위치(position)는 base에 안 굽는다 — 세 소비처가 서로 다르다(bell·presence는 아이콘
 * 우상단 코너, tab-bar는 아이콘 오른쪽 옆). `right`와 `left`는 tailwind-merge가 다른
 * 충돌군이라 className으로 덮어써도 base의 `-right-0.5`가 안 지워지고 같이 남아 폭이
 * 늘어난다(absolute+양쪽 지정+width auto는 브라우저가 늘려 채운다) — 그래서 위치는
 * 전부 호출부가 className으로 준다(position: absolute도 호출부 책임).
 *
 * variant별 색은 그대로 보존한다(destructive/info/primary는 다른 의미축 — 강제 통일
 * 대상이 아니다, PO 確定. primary=info와 같은 토큰(--proof-blue)이라 사실상 같은 값).
 * 재계산(lib/oklch-contrast.ts, 2026-09-05):
 *   destructive — 라이트 white/#C33B3B 5.24 · 다크 #0B0C0D/#E06767 5.88
 *   info        — 라이트 #FAFAFA/#3157FF 5.11 · 다크 #020E1D/#6B87FF 6.03
 *   primary     — info와 동일 토큰(라이트 fg oklch(.985 0 0) 동일·다크 fg 색상각만 262
 *                 vs 250, 값은 사실상 동일) — 별도 재계산 불요
 * (셋 다 AA 4.5 통과 — story c2bb0acd가 destructive를, §3-3 신설이 info/primary를 이미 확保)
 *
 * ⚠️접근성 이름 계약(story #3518, 유나 #3861 Design 관찰) — 이 배지는 `aria-hidden`
 * 이다(스크린리더가 이 <span>을 직접 못 읽는다). 그 수(`value`)를 보조기술에 전하는
 * 책임은 호출부에 있다 — 가장 가까운 접근성 이름(보통 이 배지를 담은 버튼/링크의
 * `aria-label`)에 그 수를 넣어야 한다. notification-bell·team-presence-toggle은
 * 이미 그렇게 한다(`bellAriaLabelCount`·`fabLabelWorking`) — 새 소비처를 추가할
 * 때 이 자리를 빠뜨리면 그 수는 스크린리더 사용자에게 조용히 사라진다(mobile-
 * tab-bar가 이 스토리 前까지 그랬다 — content-bff류가 아니라 이 계약 자체가
 * 문서화 안 돼 있던 것이 원인).
 */
const cornerCountBadgeVariants = cva(
  'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums leading-none',
  {
    variants: {
      variant: {
        destructive: 'bg-destructive text-white dark:text-proof-bg',
        info: 'bg-info text-info-foreground',
        primary: 'bg-primary text-primary-foreground',
      },
    },
  },
);

interface CornerCountBadgeProps extends VariantProps<typeof cornerCountBadgeVariants> {
  value: string | number;
  /** 위치(absolute+좌표)를 포함해 호출부가 전부 준다 — 위 주석 참고. */
  className: string;
}

export function CornerCountBadge({ variant, value, className }: CornerCountBadgeProps) {
  return (
    <span className={cn(cornerCountBadgeVariants({ variant }), className)} aria-hidden>
      {value}
    </span>
  );
}
