import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { LAYER } from './layers';

/**
 * 4913(UI-R5) PageFrame — 조직 구역 화면의 «한 쪽 틀» 바깥 상자. 본문 폭은 셋뿐이다(화면은 폭 클래스를 직접 쓰지 않는다):
 *  - `reading` 768 — 폼 · 목록 · 설정류(권한 · 신뢰 센터 · 콘텐츠 규칙 · 생성 연결 · 채널 연결 · 리워드)
 *  - `wide` 1152 — 표 · 카드 격자(성과 보드 · 레시피 · 블로그 포스트 · 채널 포스트)
 *  - `stream` — 폭 제한 없음(채널 채팅 같은 흐름 화면 · 입력줄 하단 고정은 화면 몫)
 * 바깥 여백 · 칸 간격은 한 가지(폰 16 · 데스크톱 24, 칸 사이 24), 면은 «쪽 바탕» 층(`LAYER.page`)이다 — 그 위의 패널(`Card`)이 바탕보다 한 층 올라온다(styles/layer-rule.test.ts).
 * 화면 제목은 여기 없다: 앱 틀 위 막대(`TopBarSlot`)가 가져간다(PO 11-12). 본문 머리는 `PageHead`(설명 + 행동).
 */
export type PageFrameWidth = 'reading' | 'wide' | 'stream';

// Tailwind가 클래스를 알아보게 문자열을 통째로 둔다(768px = 48rem · 1152px = 72rem).
const WIDTH_CLASS: Record<PageFrameWidth, string> = {
  reading: 'max-w-[48rem]',
  wide: 'max-w-[72rem]',
  stream: 'max-w-none',
};

export type PageFrameProps = Omit<ComponentProps<'div'>, 'className'> & {
  width?: PageFrameWidth;
  className?: string;
};

export function PageFrame({ width = 'reading', className, children, ...props }: PageFrameProps) {
  return (
    <div
      data-slot="ds-page-frame"
      data-width={width}
      className={cn('mx-auto flex w-full flex-col gap-6 p-4 sm:p-6', LAYER.page, WIDTH_CLASS[width], className)}
      {...props}
    >
      {children}
    </div>
  );
}
