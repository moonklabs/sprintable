import { useTranslations } from 'next-intl';
import type { ArtifactNode } from '@/services/canvas-nodes';
import { Input } from '@/components/ui/input';

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
        <p className="text-editorial-meta text-muted-foreground">{t('propertyPanelEmpty')}</p>
      </div>
    );
  }

  const text = typeof node.props['text'] === 'string' ? (node.props['text'] as string) : '';

  return (
    <div className={className}>
      <p className="mb-2 text-micro font-bold uppercase tracking-wide text-muted-foreground">{node.type}</p>
      <label className="mb-1 block text-micro text-muted-foreground">{t('propertyTextLabel')}</label>
      <Input
        type="text"
        value={text}
        onChange={(e) => onChangeText(node.id, e.target.value)}
        className="h-auto mb-3 px-2 py-1 lg:text-editorial-meta bg-background dark:bg-background"
      />
      <button
        type="button"
        onClick={() => onDelete(node.id)}
        className="w-full rounded-md border border-border px-2 py-1 text-editorial-meta font-semibold text-muted-foreground hover:bg-muted"
      >
        {t('propertyDeleteAction')}
      </button>
    </div>
  );
}
