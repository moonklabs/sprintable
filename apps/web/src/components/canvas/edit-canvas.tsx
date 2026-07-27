'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArtifactStage, DEFAULT_BOUNDS } from './artifact-stage';
import { SpecPinMarker } from './spec-pin-marker';
import { PinAuthoringPopover } from './pin-authoring-popover';
import { listSpecPins, createSpecPin, updateSpecPin, deleteSpecPin, type SpecPin } from '@/services/canvas-spec-pins';
import type { ResolvedNode } from '@/services/canvas-nodes';

interface EditCanvasProps {
  tree: ResolvedNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** story 7fe16274 — 스펙 핀 저작은 이미 존재하는 artifact(버전)이 있어야 가능(BE는 항상
   * latest version 대상). undefined(=신규 생성 중, 아직 첫 커밋 전)면 핀 도구를 비활성 처리
   * (안내 tooltip). */
  artifactId?: string;
  /** 배치 좌표계 정합용 — view 모드가 읽는 것과 같은 canvas_bounds를 여기서도 참조해야
   * 배치 시점(edit)과 렌더 시점(view)의 좌표가 어긋나지 않는다. 미선언이면 ArtifactStage와
   * 동일한 기본 아트보드(DEFAULT_BOUNDS)로 폴백(가짜 추정 아님 — 같은 폴백 규약 공유). */
  canvasBounds?: { w: number; h: number } | null;
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
 * — MVP 단순화, 정직 고지). `data-canvas-scrollable` — 까심 QA 비차단 발견(PR#2137) 대응
 * (PR#2138): 긴 트리(>800px) 위에서의 plain wheel은 캔버스 pan 대신 이 내부 스크롤에 양보한다
 * (ArtifactStage의 wheel 핸들러가 이 마커+실제 overflow 존재를 확인하고 pass-through).
 *
 * story 7fe16274, doc `artifact-pin-authoring-spec` v1(ⓐ 좌표 배치만) — 스펙 핀 저작.
 * 배치 제스처: 툴 활성 → 캔버스 빈 공간 클릭 → 그 지점에 draft 핀 → 팝오버 즉시 오픈(§3).
 * 좌표 환산: 클릭 지점의 화면 좌표를 오버레이 자신의 `getBoundingClientRect()`와
 * `canvasBounds`(또는 DEFAULT_BOUNDS)로 역산 — CanvasViewport가 내부 transform state를
 * 노출하지 않아도, "렌더된 폭 ÷ 논리 폭 = 현재 scale"이라는 순수 기하 관계만으로 pan/zoom과
 * 무관하게 정확한 canvas_bounds 좌표를 얻는다(엔진 내부를 건드리지 않는 최소 침습).
 * 기존 핀 클릭(재편집)은 새 배치-캐처 레이어보다 DOM 순서상 위에 그려 자연히 우선한다 —
 * stopPropagation 불필요.
 */
export function EditCanvas({ tree, selectedId, onSelect, artifactId, canvasBounds, className }: EditCanvasProps) {
  const t = useTranslations('canvas');
  const [pinToolActive, setPinToolActive] = useState(false);
  const [pins, setPins] = useState<SpecPin[]>([]);
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(null);
  const [editingPin, setEditingPin] = useState<SpecPin | null>(null);

  useEffect(() => {
    // artifactId 없으면(신규 생성 중) fetch 자체를 스킵 — pins는 이미 [] 초기값이라 굳이
    // setState할 필요가 없고, effect 본문에서 동기 setState 호출은 캐스케이드 렌더 유발(lint).
    if (!artifactId) return;
    let cancelled = false;
    void (async () => {
      const fetched = await listSpecPins(artifactId);
      if (!cancelled) setPins(fetched);
    })();
    return () => { cancelled = true; };
  }, [artifactId]);

  const boundsW = canvasBounds?.w ?? DEFAULT_BOUNDS.w;

  function handleBackgroundClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.width / boundsW;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    setDraftPin({ x, y });
  }

  async function handleSaveDraft(description: string): Promise<boolean> {
    if (!artifactId || !draftPin) return false;
    const created = await createSpecPin(artifactId, draftPin.x, draftPin.y, description);
    if (!created) return false;
    setPins((cur) => [...cur, created]);
    setDraftPin(null);
    return true;
  }

  async function handleSaveEdit(description: string): Promise<boolean> {
    if (!artifactId || !editingPin) return false;
    const updated = await updateSpecPin(artifactId, editingPin.id, description);
    if (!updated) return false;
    setPins((cur) => cur.map((p) => (p.id === updated.id ? updated : p)));
    setEditingPin(null);
    return true;
  }

  async function handleDeleteEditing(): Promise<boolean> {
    if (!artifactId || !editingPin) return false;
    const ok = await deleteSpecPin(artifactId, editingPin.id);
    if (!ok) return false;
    setPins((cur) => cur.filter((p) => p.id !== editingPin.id));
    setEditingPin(null);
    return true;
  }

  // story 70a06b22 — 배치 제스처 발견성. 배치 캐처와 완전히 같은 조건(툴 활성+draft/editing
  // 없음)이라 sticky 도구가 다음 배치를 위해 재노출될 때 힌트도 함께 자연히 재노출된다.
  const showPlacementHint = pinToolActive && !draftPin && !editingPin;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPinToolActive((v) => !v)}
          disabled={!artifactId}
          title={artifactId ? undefined : t('specPinToolUnavailableForNewArtifact')}
          className={cn(
            'flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            pinToolActive ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
          )}
        >
          <FileText className="size-3" aria-hidden />
          {t('specPinToolAction')}
        </button>
        {showPlacementHint ? <p className="text-[11px] text-muted-foreground">{t('specPinPlacementHint')}</p> : null}
      </div>

      <div className="h-[420px] w-full">
        <ArtifactStage
          format="tree"
          content=""
          title=""
          mode="edit"
          overlay={
            <div className="relative h-full w-full">
              <div data-canvas-scrollable className="h-full w-full space-y-2 overflow-auto rounded-lg border border-dashed border-border bg-background p-3">
                {tree.map((node) => <NodeBox key={node.id} node={node} selectedId={selectedId} onSelect={onSelect} />)}
              </div>
              {/* 배치 캐처 — 툴 활성 + draft/editing 팝오버가 열려있지 않을 때만(열린 상태에서
               * 또 클릭하면 미저장 draft가 조용히 덮어써지는 걸 방지). */}
              {pinToolActive && !draftPin && !editingPin ? (
                <div data-pin-placement-catcher className="absolute inset-0" onClick={handleBackgroundClick} />
              ) : null}
              {/* 핀 레이어 — 배치 캐처보다 DOM 순서상 위(같은 지점 클릭 시 핀이 우선). pointer-events는
               * 오버레이 조상(드래그 중 none)에서 그대로 상속 — AnchorPin과 동일 메커니즘. */}
              {pins.map((pin) => (
                <SpecPinMarker
                  key={pin.id}
                  active={editingPin?.id === pin.id}
                  onClick={() => setEditingPin(pin)}
                  className="absolute z-10"
                  style={{ left: pin.anchorX ?? 0, top: pin.anchorY ?? 0 }}
                />
              ))}
            </div>
          }
        />
      </div>

      {draftPin ? (
        <PinAuthoringPopover
          key="draft"
          open
          onOpenChange={(o) => { if (!o) setDraftPin(null); }}
          initialDescription=""
          onSave={handleSaveDraft}
        />
      ) : null}
      {editingPin ? (
        <PinAuthoringPopover
          key={editingPin.id}
          open
          onOpenChange={(o) => { if (!o) setEditingPin(null); }}
          initialDescription={editingPin.description}
          onSave={handleSaveEdit}
          onDelete={handleDeleteEditing}
        />
      ) : null}
    </div>
  );
}
