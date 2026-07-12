import { useTranslations } from 'next-intl';
import type { ArtifactNode } from '@/services/canvas-nodes';

interface PropertyPanelProps {
  node: ArtifactNode | null;
  onChangeText: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  className?: string;
}

/**
 * E-CANVAS C3 §2 — 속성 패널. 선택 요소 없으면 중립 안내(낙인 문구 금지, E-VERIFY/C2
 * 원칙 계승). description 인라인 편집은 C2 연동 지점이라 이번 스코프 밖 — 필드 자리만
 * 남겨두고 "coming soon" 대신 명시적으로 후속 표기.
 */
export function PropertyPanel({ node, onChangeText, onDelete, className }: PropertyPanelProps) {
  const t = useTranslations('canvas');

  if (!node) {
    return (
      <div className={className}>
        <p className="text-[11px] text-muted-foreground/70">{t('propertyPanelEmpty')}</p>
      </div>
    );
  }

  const text = typeof node.props['text'] === 'string' ? (node.props['text'] as string) : '';

  return (
    <div className={className}>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{node.type}</p>
      <label className="mb-1 block text-[10px] text-muted-foreground">{t('propertyTextLabel')}</label>
      <input
        type="text"
        value={text}
        onChange={(e) => onChangeText(node.id, e.target.value)}
        className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
      />
      <button
        type="button"
        onClick={() => onDelete(node.id)}
        className="w-full rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted"
      >
        {t('propertyDeleteAction')}
      </button>
    </div>
  );
}
