import { cn } from '@/lib/utils';

interface AnchorPinProps {
  number: number;
  /** open=info 채움·resolved=muted 아웃라인(핸드오프 §1-2). */
  state: 'open' | 'resolved';
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
        state === 'open' ? 'bg-info text-white' : 'border-2 border-border bg-transparent text-muted-foreground',
        active && 'ring-2 ring-info/40',
        onClick && 'hover:scale-110',
        className,
      )}
    >
      {number}
    </Tag>
  );
}
