import { cn } from '@/lib/utils';
import { ArtifactStage } from './artifact-stage';
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
 * E-CANVAS C3 §2, story 1948d19d §3(PR B) — 편집 캔버스도 뷰어와 같은 CanvasViewport 엔진 위에
 * (큰 뷰포트+pan/zoom, "전 표면 통일"의 편집판). tree는 cross-origin 콘텐츠가 없는 우리 자체
 * DOM이라 선택 가능한 노드 트리를 그대로 `overlay`로 얹는다 — 핀과 동일한 pointer-events
 * 토글(드래그 확定 시 오버레이 pointer-events:none)을 그대로 재사용, 새 hit-test 불필요.
 * 클릭 선택만 지원(드래그/리사이즈는 스코프 제외 — tree 포맷은 구조 편집이 본질이라 자유
 * 좌표 이동보다 select→속성패널이 더 정합한 MVP 선택, PR A 이전부터의 기존 결정 유지).
 * 노드 트리는 문서 플로우 그대로라 개별 좌표 계산이 필요 없어 오버레이 박스 안에서
 * overflow-auto로 내부 스크롤(캔버스 bounds 자체를 콘텐츠 높이에 맞춰 동적 산정하지 않음
 * — MVP 단순화, 정직 고지).
 */
export function EditCanvas({ tree, selectedId, onSelect, className }: EditCanvasProps) {
  return (
    <div className={cn('h-[420px] w-full', className)}>
      <ArtifactStage
        format="tree"
        content=""
        title=""
        mode="edit"
        overlay={
          <div className="h-full w-full space-y-2 overflow-auto rounded-lg border border-dashed border-border bg-background p-3">
            {tree.map((node) => <NodeBox key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />)}
          </div>
        }
      />
    </div>
  );
}
