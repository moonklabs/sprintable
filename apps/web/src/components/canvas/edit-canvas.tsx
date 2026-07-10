import { cn } from '@/lib/utils';
import type { ResolvedNode } from '@/services/canvas-nodes';

interface EditCanvasProps {
  tree: ResolvedNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

function NodeBox({ node, selectedId, onSelect }: { node: ResolvedNode; selectedId: string | null; onSelect: (id: string) => void }) {
  const text = typeof node.props['text'] === 'string' ? (node.props['text'] as string) : node.type;
  const selected = node.id === selectedId;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      className={cn(
        'block w-full rounded-md border p-2 text-left text-xs transition-colors',
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-primary/30',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{node.type}</span>
      <p className="mt-0.5 truncate text-foreground">{text}</p>
      {node.children.length > 0 ? (
        <div className="mt-1.5 space-y-1.5 border-l border-border pl-2">
          {node.children.map((c) => <NodeBox key={c.id} node={c} selectedId={selectedId} onSelect={onSelect} />)}
        </div>
      ) : null}
    </button>
  );
}

/**
 * E-CANVAS C3 §2 — 편집 캔버스. 클릭 선택만 지원(드래그/리사이즈는 스코프 제외 — tree
 * 포맷은 구조 편집이 본질이라 자유 좌표 이동보다 select→속성패널이 더 정합한 MVP 선택).
 */
export function EditCanvas({ tree, selectedId, onSelect, className }: EditCanvasProps) {
  return (
    <div className={cn('space-y-2 rounded-lg border border-dashed border-border p-3', className)}>
      {tree.map((node) => <NodeBox key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />)}
    </div>
  );
}
