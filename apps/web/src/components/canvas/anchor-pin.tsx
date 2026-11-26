import { cn } from '@/lib/utils';

interface AnchorPinProps {
  /** story #2725 — draft(저장 전 임시 핀)는 아직 pin_number가 없다(스레드 자체가 미생성). */
  number: number | null;
  /** open=ds action 채움·resolved=면 색 채움 + 중간 톤 테두리(핸드오프 §1-2의 «가라앉은 아웃라인»)·draft=점선+pulse(story #2725,
   * 아직 저장되지 않은 임시 핀 — «아직 남 앞에 안 보인다»를 시각적으로 구분). */
  state: 'open' | 'resolved' | 'draft';
  active?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
  /** story #4373 — 쓰기 칸이 이 핀 사각형에 붙는다(React 19 ref prop). */
  ref?: React.Ref<HTMLElement>;
}

/**
 * E-CANVAS C2 — 요소 앵커 핀. 헤더 배지·스테이지 오버레이 양쪽에서 재사용(§1-2 anatomy).
 * 클릭 가능하면 버튼, 아니면 순수 표시(스테이지 오버레이는 항상 클릭 가능하게 쓸 예정).
 */
export function AnchorPin({ number, state, active, onClick, className, style, ref }: AnchorPinProps) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      ref={ref as React.Ref<HTMLButtonElement & HTMLSpanElement>}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      style={style}
      // 4910 — ds 토큰. 핀은 «그림 위»에 서므로(임의의 색 위) 채움이 흰 · 검은 그림 둘 다에서 3:1 이상이어야 한다.
      // story 5048 T0 ①: 주 행동색이 검정 · 흰이 되면 한쪽 그림에서 사라지므로, 핀은 «어느 그림 위에서도 4.5:1 안팎»인 가운데 톤 전용 토큰(ds-pin #767676 · 글자 ds-on-pin 흰)을 쓴다.
      // 가운데 톤 그림에서도 갈리게 채움 둘레에 2px 면 색 고리(ring-ds-surface)를 둔다 — 숫자 글은 채움 위 4.5:1 이상. 값은 styles/pin-contrast.4910.test.tsx가 지킨다.
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-ds-mono-md font-bold transition-transform',
        state === 'open' && 'bg-ds-pin text-ds-on-pin ring-2 ring-ds-surface',
        state === 'resolved' && 'border-2 border-ds-line-control bg-ds-surface text-ds-ink-3',
        state === 'draft' && 'animate-pulse border-2 border-dashed border-ds-pin bg-ds-action-soft text-ds-action-text',
        active && 'outline-2 outline-offset-2 outline-ds-action',
        onClick && 'hover:scale-110',
        className,
      )}
    >
      {number}
    </Tag>
  );
}
