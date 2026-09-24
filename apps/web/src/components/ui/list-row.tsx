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
      {/* [SID:4282 · 유나 추가 결정] 글자 칸이 basis 0(flex-1)이면 flex-wrap이 안 꺾여 390에서 글자 칸이 50px까지 줄었다
          (신뢰 센터 꼬리 잘림 · en 부제 낱말 중간 끊김). 글자 칸은 10rem을 바탕 너비로 두고, 상태 · 동작 · 메뉴는 한 묶음
          (ml-auto shrink-0)으로 같이 다음 줄로 내려간다. 넓은 폭(1440)에선 종전처럼 한 줄. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {mark}
        <div className="min-w-0 flex-[1_1_10rem]">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {/* story #3743 CHANGES ①(페드루 PO, 2026-09-09 12:54Z) — 부제를 한 줄로
              자르면(truncate) 시안이 요구하는 긴 한 문장(Facebook 만료 안내 등)이
              말줄임된다. 문장마다 줄이는 대신 부제 자체를 2줄까지 줄바꿈 허용. */}
          {/* [SID:4282 · 유나 결정] 한국어는 띄어쓰기에서만 꺾고(break-keep · «판정한 가/설이» 방지), 띄어쓰기 없는 긴 토큰은
              어디서든 꺾는다(overflow-wrap:anywhere · 칸을 뚫지 않게). 공용 슬롯이라 소비처 넷 모두에 같이 적용. */}
          {subtitle ? <p className="line-clamp-2 break-keep text-xs text-muted-foreground [overflow-wrap:anywhere]">{subtitle}</p> : null}
        </div>
        {status || action || menu ? (
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {status}
            {action}
            {menu}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// 유나 지적(#4090 리뷰, 2026-09-09 13:13Z) — 이름 있는 프리셋(neutral/blue) 소비처가
// 0이었다(모든 호출부가 channelMarkColor()의 hex를 그대로 넘긴다). 안 쓰는 갈래를
// 남겨두지 않는다 — color는 hex 하나로.
/** 시안의 30×30 색 표식(채널 이니셜류). */
export function ListRowMark({ label, color }: { label: string; color: string }) {
  return (
    <span
      // [SID:4282 · 유나 결정] 다크에서 검정 계열 브랜드색(Threads · X · Ghost)이 카드에 묻힌다(대비 1.02~1.19:1) → 다크에서만 옅은 테두리.
      className="flex size-[30px] shrink-0 items-center justify-center rounded-md text-xs font-bold text-white dark:ring-1 dark:ring-border"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
