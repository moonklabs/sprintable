import { cn } from '@/lib/utils';

interface AnchorPinProps {
  /** story #2725 — draft(저장 전 임시 핀)는 아직 pin_number가 없다(스레드 자체가 미생성). */
  number: number | null;
  /** open=info 채움·resolved=muted 아웃라인(핸드오프 §1-2)·draft=점선+pulse(story #2725,
   * 아직 저장되지 않은 임시 핀 — «아직 남 앞에 안 보인다»를 시각적으로 구분). */
  state: 'open' | 'resolved' | 'draft';
  active?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * E-CANVAS C2 — 요소 앵커 핀. 헤더 배지·스테이지 오버레이 양쪽에서 재사용(§1-2 anatomy).
 * 클릭 가능하면 버튼, 아니면 순수 표시(스테이지 오버레이는 항상 클릭 가능하게 쓸 예정).
 */
export function AnchorPin({ number, state, active, onClick, className, style }: AnchorPinProps) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      style={style}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full rounded-bl-none text-[10px] font-bold transition-transform',
        state === 'open' && 'bg-info text-white',
        state === 'resolved' && 'border-2 border-border bg-transparent text-muted-foreground',
        state === 'draft' && 'animate-pulse border-2 border-dashed border-primary bg-primary/10 text-primary',
        active && 'ring-2 ring-info/40',
        onClick && 'hover:scale-110',
        className,
      )}
    >
      {number}
    </Tag>
  );
}
