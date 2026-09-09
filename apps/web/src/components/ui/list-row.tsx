import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * story #3743(UI 재설계 ③, 유나 시안 a98386e6) — 「행 목록」 공통 부품(문서 §「시안 7장이
 * 요구하는 공통 부품」#③). 「한 테두리 안 나뉜 목록」 형 — 카드형 낱개(MemberRow)와 다르다.
 * 표식(마크)+이름+부제+상태+다음 발(액션/메뉴)를 한 줄에, 그 아래 임의 콘텐츠(펼침 폼·
 * 오류·부가 정보)를 children으로 — 채널 연결(③)·신뢰 센터(⑤)·콘텐츠 규칙(⑥)이 재사용.
 * 이름·정확한 props 모양은 유나 확認 축(2026-09-09, 페드루 PO 위임) — 확定 전 사용처가
 * 이 자리 하나뿐이라 이름이 바뀌어도 이관 비용은 이 파일+호출부 1곳뿐이다.
 */
export function ListRow({
  mark,
  title,
  subtitle,
  status,
  action,
  menu,
  children,
  className,
  'data-testid': dataTestId,
}: {
  mark?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  action?: React.ReactNode;
  menu?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div className={cn('space-y-2 px-3 py-3', className)} data-testid={dataTestId}>
      <div className="flex flex-wrap items-center gap-3">
        {mark}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {status}
        {action}
        {menu}
      </div>
      {children}
    </div>
  );
}

const MARK_COLORS: Record<string, string> = {
  neutral: 'bg-foreground',
  blue: 'bg-[#3157FF]',
};

/** 시안의 30×30 색 표식(채널 이니셜류). color는 팔레트 자유값이 아니라 소수 프리셋 —
 * 임의 hex를 호출부가 지어내면 채널마다 색이 흩어진다(시안은 채널 브랜드색 고정 팔레트). */
export function ListRowMark({ label, color = 'neutral' }: { label: string; color?: keyof typeof MARK_COLORS | string }) {
  const bgClass = MARK_COLORS[color] ?? undefined;
  return (
    <span
      className={cn('flex size-[30px] shrink-0 items-center justify-center rounded-md text-xs font-bold text-white', bgClass)}
      style={bgClass ? undefined : { backgroundColor: color }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
