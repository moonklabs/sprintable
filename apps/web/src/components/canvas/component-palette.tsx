import { useTranslations } from 'next-intl';
import { PALETTE_TYPES } from '@/services/canvas-nodes';

interface ComponentPaletteProps {
  onAdd: (type: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * E-CANVAS C3 §2 — 부품 팔레트. 전신 `/mockups` `MOCK_PALETTE_ITEMS` 계승(타입 목록만 —
 * 드래그 물리는 스코프 제외, 클릭 추가로 단순화한 MVP). 선택된 컨테이너에 자식으로 추가.
 */
export function ComponentPalette({ onAdd, disabled, className }: ComponentPaletteProps) {
  const t = useTranslations('canvas');
  return (
    <div className={className}>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{t('paletteLabel')}</p>
      <div className="space-y-1.5">
        {PALETTE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            disabled={disabled}
            onClick={() => onAdd(type)}
            className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-left text-[11px] text-foreground hover:border-primary/40 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {type}
          </button>
        ))}
      </div>
    </div>
  );
}
