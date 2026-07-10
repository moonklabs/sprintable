'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ComponentPalette } from './component-palette';
import { EditCanvas } from './edit-canvas';
import { PropertyPanel } from './property-panel';
import { CommitBar } from './commit-bar';
import { ExportDialog, type ExportFormat, type ExportTheme, type ExportViewport } from './export-dialog';
import {
  resolveNodeTree, addNode, deleteNode, updateNodeProp, countNodeChanges, commitNodesToNextVersion,
  type ArtifactNode,
} from '@/services/canvas-nodes';

interface ArtifactEditorProps {
  title: string;
  initialNodes: ArtifactNode[];
  /** 커밋 시 호출 — 실 연동에선 이게 `POST .../versions`(node.id 보존 계약)가 됨. */
  onCommit?: (nodes: ArtifactNode[], summary: string) => void;
  onDone?: () => void;
  className?: string;
}

/**
 * E-CANVAS C3 — Lv3 편집 모드 오리케스트레이터(핸드오프 §2). 부품 팔레트+캔버스+속성패널+
 * 커밋바+export 진입점을 한 화면에. 노드 조작은 flat-list 위에서 동작(services/canvas-nodes.ts)
 * — id 재발급 없이 mutate만 하므로 커밋해도 살아있는 요소의 node.id가 자동 보존된다
 * (C1 계약 §3이 C3로 defer한 "버전 간 node.id 안정성"의 실제 구현 — 별도 로직 불필요).
 */
export function ArtifactEditor({ title, initialNodes, onCommit, onDone, className }: ArtifactEditorProps) {
  const t = useTranslations('canvas');
  const [baseline, setBaseline] = useState(initialNodes);
  const [nodes, setNodes] = useState(initialNodes);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const tree = useMemo(() => resolveNodeTree(nodes), [nodes]);
  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const changeCount = useMemo(() => countNodeChanges(baseline, nodes), [baseline, nodes]);

  const handleAdd = (type: string) => setNodes((prev) => addNode(prev, type, selectedId));
  const handleDelete = (id: string) => {
    setNodes((prev) => deleteNode(prev, id));
    if (selectedId === id) setSelectedId(null);
  };
  const handleChangeText = (id: string, text: string) => setNodes((prev) => updateNodeProp(prev, id, 'text', text));
  const handleCommit = (summary: string) => {
    const committed = commitNodesToNextVersion(nodes);
    onCommit?.(committed, summary);
    setBaseline(committed);
  };
  const handleExport = (_format: ExportFormat, _viewport: ExportViewport, _theme: ExportTheme) => {
    // mock — C1-S5(GCS export 파이프) 미착지. 실 연동 시 여기서 업로드 API 호출.
  };

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            {t('editModeLabel')}
          </span>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          >
            <Download className="h-3 w-3" aria-hidden />
            {t('exportAction')}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-[120px_1fr_160px]">
          <ComponentPalette onAdd={handleAdd} />
          <EditCanvas tree={tree} selectedId={selectedId} onSelect={setSelectedId} />
          <PropertyPanel node={selectedNode} onChangeText={handleChangeText} onDelete={handleDelete} />
        </div>

        <div className="px-3 pb-3">
          <CommitBar changeCount={changeCount} onCommit={handleCommit} onDone={onDone} />
        </div>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} onExport={handleExport} />
    </div>
  );
}
