import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SpecPinMarkerProps {
  active?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * story 7fe16274 §4 — 스펙 핀 시각. 코멘트 핀(`AnchorPin`)과 같은 캔버스 핀 레이어를
 * 공유하되(pan/zoom 동반·클릭=열기) 아이콘으로 구분(둘 다 같은 채움 색이라 아이콘이 유일한
 * 신뢰 가능한 구분 신호 — spec §4 표: "번호/스펙 아이콘" vs "말풍선 아이콘"). 감시금지(§4):
 * 작성자/시간 props 자체가 없음(ArtifactSpecPin과 동형).
 */
export function SpecPinMarker({ active, onClick, className, style }: SpecPinMarkerProps) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      style={style}
      className={cn(
        // 4910 — 코멘트 핀(AnchorPin open)과 같은 ds 채움 · 고리(같은 대비 값 — styles/pin-contrast.4910.test.ts). 구분 신호는 여전히 아이콘.
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full rounded-bl-none bg-ds-action text-ds-on-action ring-2 ring-ds-surface transition-transform',
        active && 'outline-2 outline-offset-2 outline-ds-action',
        onClick && 'hover:scale-110',
        className,
      )}
    >
      <FileText className="size-3" aria-hidden />
    </Tag>
  );
}
