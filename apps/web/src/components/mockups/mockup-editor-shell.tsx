'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  MOCKUP_PALETTE_ITEMS,
  alignSelectedComponents,
  cloneMockupComponents,
  componentCanContainChildren,
  distributeSelectedComponents,
  duplicateSelectedComponents,
  ensureSelectedIds,
  extractSelectedComponents,
  getDefaultComponentSize,
  reindexComponentSortOrder,
  removeComponentsByIds,
  resolveMockupLayout,
  type MockupAlignmentAxis,
  type MockupComponent,
  type MockupDistributionAxis,
  type MockupLayerAction,
  type MockupResolvedBox,
  type MockupResolvedLayout,
  type MockupResolvedNode,
  type MockupScenario,
  updateSelectedLayerOrder,
} from './mockup-editor-utils';

type VersionEntry = {
  id: string;
  version: number;
  created_at: string;
};

type ClipboardSnapshot = {
  components: MockupComponent[];
  selectedIds: string[];
} | null;

type SnapLine = { type: 'h' | 'v'; pos: number };

type DragSession = {
  parentId: string | null;
  selectedIds: string[];
  baseComponents: MockupComponent[];
  baseLayout: MockupResolvedLayout;
  pointerX: number;
  pointerY: number;
  moved: boolean;
};

interface MockupEditorShellProps {
  mockupId: string;
}

const GRID_SIZE = 16;
const SNAP_THRESHOLD = 6;
const TINY_BUTTON_CLASS = 'rounded-xl border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-2.5 py-1.5 text-[11px] text-[color:var(--operator-foreground)] transition hover:border-[color:var(--operator-primary)]/18 hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-50';

function cloneState(components: MockupComponent[]) {
  return cloneMockupComponents(components);
}

function snapshotKey(components: MockupComponent[]) {
  return JSON.stringify(components);
}

function isTypingTarget(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function parsePropValue(current: unknown, next: string) {
  if (typeof current === 'number') {
    const parsed = Number(next);
    return Number.isFinite(parsed) ? parsed : current;
  }
  if (typeof current === 'boolean') {
    return next === 'true' || next === '1';
  }
  return next;
}

function createId(prefix: string) {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function mergeBoxStyle(box: MockupResolvedBox): CSSProperties {
  return {
    position: 'absolute',
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    zIndex: box.zIndex,
  };
}

function componentPaletteEntry(type: string) {
  return MOCKUP_PALETTE_ITEMS.find((item) => item.type === type);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

function getNodePadding(component: MockupComponent) {
  const rawPadding = component.props.padding;
  if (typeof rawPadding === 'number' && Number.isFinite(rawPadding)) return rawPadding;
  return componentCanContainChildren(component.component_type) ? 16 : 12;
}

type TreeRow = { node: MockupResolvedNode; depth: number };

function buildTreeNodeRows(nodes: MockupResolvedNode[], depth = 0): TreeRow[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...buildTreeNodeRows(node.children, depth + 1),
  ]);
}

function MockupNodeContent({ component }: { component: MockupComponent }) {
  const type = component.component_type;
  const props = component.props;
  const text = typeof props.text === 'string' ? props.text : typeof props.title === 'string' ? props.title : type;

  if (type === 'Button') {
    return (
      <div className="flex h-full items-center justify-center rounded-xl bg-blue-500 px-3 py-2 text-xs font-medium text-white shadow-sm">
        {text}
      </div>
    );
  }

  if (type === 'Input') {
    return (
      <div className="flex h-full items-center rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-400">
        {(props.placeholder as string) ?? 'Enter text...'}
      </div>
    );
  }

  if (type === 'Card') {
    return (
      <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-sm font-semibold text-slate-800">{text}</div>
        <div className="mt-2 text-xs leading-5 text-slate-500">{typeof props.content === 'string' ? props.content : 'Card content'}</div>
      </div>
    );
  }

  if (type === 'Container') {
    return (
      <div className="flex h-full flex-col rounded-2xl border border-dashed border-slate-300 bg-slate-50/80 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Container</div>
      </div>
    );
  }

  if (type === 'Text') {
    return <div className="px-1 py-0.5 text-sm text-slate-700">{text}</div>;
  }

  if (type === 'Image') {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 text-xs text-slate-400">
        Image
      </div>
    );
  }

  if (type === 'Table') {
    const rows = Number(props.rows ?? 3);
    const cols = Number(props.cols ?? 3);
    return (
      <div className="h-full rounded-2xl border border-slate-200 bg-white p-2 text-[10px] text-slate-500">
        <div className="grid gap-px overflow-hidden rounded-xl bg-slate-200" style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))` }}>
          {Array.from({ length: Math.max(rows, 1) * Math.max(cols, 1) }).map((_, index) => (
            <div key={index} className="min-h-6 bg-white px-2 py-1">—</div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'Badge') {
    return (
      <div className="inline-flex h-full items-center justify-center rounded-full bg-blue-500 px-3 py-1 text-xs font-medium text-white">
        {text}
      </div>
    );
  }

  if (type === 'Alert') {
    return (
      <div className="flex h-full items-center rounded-2xl border border-amber-200 bg-amber-50 px-3 text-xs text-amber-900">
        {text}
      </div>
    );
  }

  return <div className="px-2 py-1 text-xs text-slate-500">{text}</div>;
}

export function MockupEditorShell({ mockupId }: MockupEditorShellProps) {
  const t = useTranslations('mockup');
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [components, setComponents] = useState<MockupComponent[]>([]);
  const [scenarios, setScenarios] = useState<MockupScenario[]>([]);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [showGrid, setShowGrid] = useState(true);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [isMobileView, setIsMobileView] = useState(false);

  const clipboardRef = useRef<ClipboardSnapshot>(null);
  const historyPastRef = useRef<MockupComponent[][]>([]);
  const historyFutureRef = useRef<MockupComponent[][]>([]);
  const dragRef = useRef<DragSession | null>(null);

  useEffect(() => {
    const update = () => setIsMobileView(window.innerWidth < 768);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const layout = useMemo(() => resolveMockupLayout(components), [components]);
  const componentById = useMemo(() => new Map(components.map((component) => [component.id, component] as const)), [components]);
  const selectedComponent = selectedIds.length === 1 ? componentById.get(selectedIds[0]) ?? null : null;

  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  const recordSnapshot = useCallback((snapshot: MockupComponent[]) => {
    const normalized = cloneState(reindexComponentSortOrder(snapshot));
    const last = historyPastRef.current[historyPastRef.current.length - 1];
    if (!last || snapshotKey(last) !== snapshotKey(normalized)) {
      historyPastRef.current.push(normalized);
    }
    historyFutureRef.current = [];
  }, []);

  const applyComponents = useCallback((next: MockupComponent[], selection?: string[] | null) => {
    const normalized = reindexComponentSortOrder(next);
    setComponents(normalized);
    recordSnapshot(normalized);
    setHasChanges(true);
    if (selection === null) {
      setSelectedIds([]);
    } else if (selection) {
      setSelectedIds(ensureSelectedIds(selection, normalized.map((component) => component.id)));
    } else {
      setSelectedIds((current) => ensureSelectedIds(current, normalized.map((component) => component.id)));
    }
  }, [recordSnapshot]);

  const loadMockup = useCallback(async () => {
    setLoading(true);
    try {
      const [mockupRes, scenariosRes, versionsRes] = await Promise.all([
        fetch(`/api/mockups/${mockupId}`),
        fetch(`/api/mockups/${mockupId}/scenarios`),
        fetch(`/api/mockups/${mockupId}/versions`),
      ]);

      if (mockupRes.ok) {
        const json = await mockupRes.json();
        const data = json?.data as { title?: string; components?: MockupComponent[] } | undefined;
        const nextComponents = reindexComponentSortOrder(cloneState(data?.components ?? []));
        setTitle(data?.title ?? '');
        setComponents(nextComponents);
        historyPastRef.current = [cloneState(nextComponents)];
        historyFutureRef.current = [];
        clipboardRef.current = null;
        setSelectedIds([]);
        setHasChanges(false);
      }

      if (scenariosRes.ok) {
        const json = await scenariosRes.json();
        setScenarios((json?.data ?? []) as MockupScenario[]);
      }

      if (versionsRes.ok) {
        const json = await versionsRes.json();
        setVersions((json?.data ?? []) as VersionEntry[]);
      }
    } finally {
      setLoading(false);
    }
  }, [mockupId]);

  useEffect(() => {
    void loadMockup();
  }, [loadMockup]);

  const refreshScenarios = useCallback(async () => {
    const res = await fetch(`/api/mockups/${mockupId}/scenarios`);
    if (res.ok) {
      const json = await res.json();
      setScenarios((json?.data ?? []) as MockupScenario[]);
    }
  }, [mockupId]);

  const refreshVersions = useCallback(async () => {
    const res = await fetch(`/api/mockups/${mockupId}/versions`);
    if (res.ok) {
      const json = await res.json();
      setVersions((json?.data ?? []) as VersionEntry[]);
    }
  }, [mockupId]);

  const undo = useCallback(() => {
    if (historyPastRef.current.length <= 1) return;
    const current = historyPastRef.current.pop();
    if (!current) return;
    historyFutureRef.current.push(cloneState(current));
    const previous = historyPastRef.current[historyPastRef.current.length - 1];
    setComponents(cloneState(previous));
    setSelectedIds((currentIds) => ensureSelectedIds(currentIds, previous.map((component) => component.id)));
    setHasChanges(true);
  }, []);

  const redo = useCallback(() => {
    const next = historyFutureRef.current.pop();
    if (!next) return;
    const cloned = cloneState(next);
    historyPastRef.current.push(cloned);
    setComponents(cloned);
    setSelectedIds((currentIds) => ensureSelectedIds(currentIds, cloned.map((component) => component.id)));
    setHasChanges(true);
  }, []);

  const selectSingle = useCallback((id: string) => {
    setSelectedIds([id]);
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return [...current, id];
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const createComponent = useCallback((type: string) => {
    const palette = componentPaletteEntry(type);
    const defaultSize = getDefaultComponentSize(type);
    const nextId = createId('component');
    const selectedId = selectedIdsRef.current[selectedIdsRef.current.length - 1];
    const selectedBox = selectedId ? layout.boxesById[selectedId] : null;
    const selectedComponentEntry = selectedId ? componentById.get(selectedId) ?? null : null;
    const parentId = selectedComponentEntry && componentCanContainChildren(selectedComponentEntry.component_type)
      ? selectedComponentEntry.id
      : null;
    const siblingsCount = components.filter((component) => component.parent_id === parentId).length;
    const parentBox = parentId ? layout.boxesById[parentId] : null;
    const padding = parentId ? Number(parentBox?.localX ?? 16) : 0;
    const nextComponent: MockupComponent = {
      id: nextId,
      parent_id: parentId,
      component_type: type,
      props: {
        ...(palette?.defaultProps ?? {}),
        w: defaultSize.w,
        h: defaultSize.h,
        x: parentId
          ? padding
          : (selectedBox ? selectedBox.x + 32 : 48 + siblingsCount * 24),
        y: parentId
          ? padding + siblingsCount * (defaultSize.h + 12)
          : (selectedBox ? selectedBox.y + 32 : 48 + siblingsCount * 24),
        zIndex: siblingsCount,
      },
      spec_description: null,
      sort_order: siblingsCount,
    };

    applyComponents([...components, nextComponent], [nextId]);
  }, [applyComponents, componentById, components, layout.boxesById]);

  const deleteSelection = useCallback(() => {
    if (!selectedIds.length) return;
    applyComponents(removeComponentsByIds(components, selectedIds), []);
  }, [applyComponents, components, selectedIds]);

  const duplicateSelection = useCallback(() => {
    if (!selectedIds.length) return;
    const clipboard = extractSelectedComponents(components, selectedIds);
    const clipboardLayout = resolveMockupLayout(clipboard.components);
    const duplicated = duplicateSelectedComponents(
      clipboard.components,
      clipboardLayout.boxesById,
      clipboard.selectedIds,
      { idFactory: (sourceId, index) => createId(`dup-${index}-${sourceId}`) },
    );
    const clones = duplicated.components.slice(clipboard.components.length);
    applyComponents([...components, ...clones], duplicated.selectedIds);
  }, [applyComponents, components, selectedIds]);

  const copySelection = useCallback(async () => {
    if (!selectedIds.length) return;
    const clipboard = extractSelectedComponents(components, selectedIds);
    clipboardRef.current = clipboard;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ ids: clipboard.selectedIds, count: clipboard.components.length }));
    } catch {
      // local clipboard only
    }
  }, [components, selectedIds]);

  const pasteClipboard = useCallback(() => {
    const clipboard = clipboardRef.current;
    if (!clipboard || !clipboard.selectedIds.length) return;
    const clipboardLayout = resolveMockupLayout(clipboard.components);
    const duplicated = duplicateSelectedComponents(
      clipboard.components,
      clipboardLayout.boxesById,
      clipboard.selectedIds,
      { idFactory: (sourceId, index) => createId(`paste-${index}-${sourceId}`) },
    );
    const clones = duplicated.components.slice(clipboard.components.length);
    applyComponents([...components, ...clones], duplicated.selectedIds);
  }, [applyComponents, components]);

  const applyLayerAction = useCallback((action: MockupLayerAction) => {
    if (!selectedIds.length) return;
    applyComponents(updateSelectedLayerOrder(components, layout.boxesById, selectedIds, action), selectedIds);
  }, [applyComponents, components, layout.boxesById, selectedIds]);

  const applyAlignment = useCallback((axis: MockupAlignmentAxis) => {
    if (selectedIds.length < 2) return;
    applyComponents(alignSelectedComponents(components, layout.boxesById, selectedIds, axis), selectedIds);
  }, [applyComponents, components, layout.boxesById, selectedIds]);

  const applyDistribution = useCallback((axis: MockupDistributionAxis) => {
    if (selectedIds.length < 2) return;
    applyComponents(distributeSelectedComponents(components, layout.boxesById, selectedIds, axis), selectedIds);
  }, [applyComponents, components, layout.boxesById, selectedIds]);

  const updateSelectedProp = useCallback((key: string, rawValue: string) => {
    if (!selectedComponent) return;
    const next = components.map((component) => {
      if (component.id !== selectedComponent.id) return component;
      return {
        ...component,
        props: {
          ...component.props,
          [key]: parsePropValue(component.props[key], rawValue),
        },
      };
    });
    applyComponents(next, selectedIds);
  }, [applyComponents, components, selectedComponent, selectedIds]);

  const updateSelectedSpec = useCallback((value: string) => {
    if (!selectedComponent) return;
    const next = components.map((component) => component.id === selectedComponent.id
      ? { ...component, spec_description: value.trim() ? value : null }
      : component,
    );
    applyComponents(next, selectedIds);
  }, [applyComponents, components, selectedComponent, selectedIds]);

  const loadScenario = useCallback(async () => {
    const res = await fetch(`/api/mockups/${mockupId}/scenarios`);
    if (!res.ok) return;
    const json = await res.json();
    setScenarios((json?.data ?? []) as MockupScenario[]);
  }, [mockupId]);

  const addScenario = useCallback(async () => {
    await fetch(`/api/mockups/${mockupId}/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${t('newScenarioName')} ${scenarios.length + 1}` }),
    });
    await loadScenario();
  }, [loadScenario, mockupId, scenarios.length, t]);

  const renameScenario = useCallback(async (scenarioId: string) => {
    await fetch(`/api/mockups/${mockupId}/scenarios`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenarioId, name: editingName }),
    });
    setEditingScenarioId(null);
    await refreshScenarios();
  }, [editingName, mockupId, refreshScenarios]);

  const deleteScenario = useCallback(async (scenarioId: string) => {
    const scenario = scenarios.find((item) => item.id === scenarioId);
    if (scenario?.is_default) return;
    await fetch(`/api/mockups/${mockupId}/scenarios`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenarioId }),
    });
    if (activeScenarioId === scenarioId) setActiveScenarioId(null);
    await refreshScenarios();
  }, [activeScenarioId, mockupId, refreshScenarios, scenarios]);

  const saveScenarioOverrides = useCallback(async (scenarioId: string, overrides: Record<string, Record<string, unknown>>) => {
    await fetch(`/api/mockups/${mockupId}/scenarios`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario_id: scenarioId, override_props: overrides }),
    });
    await refreshScenarios();
  }, [mockupId, refreshScenarios]);

  const restoreVersion = useCallback(async (versionId: string) => {
    setSaving(true);
    try {
      await fetch(`/api/mockups/${mockupId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId }),
      });
      await loadMockup();
      await refreshVersions();
      await refreshScenarios();
      setActiveScenarioId(null);
      setShowVersions(false);
    } finally {
      setSaving(false);
    }
  }, [loadMockup, mockupId, refreshScenarios, refreshVersions]);

  const saveMockup = useCallback(async () => {
    setSaving(true);
    try {
      const nextComponents = reindexComponentSortOrder(components);
      await fetch(`/api/mockups/${mockupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          components: nextComponents.map((component) => ({
            id: component.id,
            parent_id: component.parent_id,
            component_type: component.component_type,
            props: component.props,
            spec_description: component.spec_description,
            sort_order: component.sort_order,
          })),
        }),
      });
      setComponents(nextComponents);
      historyPastRef.current = [cloneState(nextComponents)];
      historyFutureRef.current = [];
      setHasChanges(false);
      await refreshVersions();
    } finally {
      setSaving(false);
    }
  }, [components, mockupId, refreshVersions, title]);

  const handleTreeSelect = useCallback((id: string, event: MouseEvent) => {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    event.stopPropagation();
    if (additive) {
      toggleSelection(id);
      return;
    }
    selectSingle(id);
  }, [selectSingle, toggleSelection]);

  const beginDrag = useCallback((id: string, event: MouseEvent) => {
    const component = componentById.get(id);
    const box = layout.boxesById[id];
    if (!component || !box) return;

    const activeSelection = selectedIds.includes(id)
      ? selectedIds.filter((selectedId) => componentById.get(selectedId)?.parent_id === component.parent_id)
      : [id];

    const dragSelection = activeSelection.length ? activeSelection : [id];
    if (!selectedIds.includes(id)) {
      setSelectedIds([id]);
    }

    const baseComponents = cloneState(components);
    const baseLayout = resolveMockupLayout(baseComponents);

    dragRef.current = {
      parentId: component.parent_id,
      selectedIds: dragSelection,
      baseComponents,
      baseLayout,
      pointerX: event.clientX,
      pointerY: event.clientY,
      moved: false,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    setSnapLines([]);
  }, [componentById, components, selectedIds, layout.boxesById]);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const session = dragRef.current;
    if (!session) return;

    const scale = Math.max(zoom / 100, 0.0001);
    const dx = (event.clientX - session.pointerX) / scale;
    const dy = (event.clientY - session.pointerY) / scale;
    if (!dx && !dy) return;

    session.moved = true;
    const baseBoxes = session.baseLayout.boxesById;
    const selectedSet = new Set(session.selectedIds);
    const movingBoxes = session.selectedIds.map((id) => baseBoxes[id]).filter(isDefined);
    if (!movingBoxes.length) return;

    const left = Math.min(...movingBoxes.map((box) => box.x));
    const top = Math.min(...movingBoxes.map((box) => box.y));
    const right = Math.max(...movingBoxes.map((box) => box.x + box.w));
    const bottom = Math.max(...movingBoxes.map((box) => box.y + box.h));
    const width = right - left;
    const height = bottom - top;

    const siblings = Object.entries(baseBoxes)
      .filter(([id, box]) => !selectedSet.has(id) && box.parent_id === session.parentId)
      .map(([, box]) => box);

    let snappedLeft = left + dx;
    let snappedTop = top + dy;
    const lines: SnapLine[] = [];

    const findSnap = (current: number, candidates: { value: number; line: number }[]) => {
      let best: { value: number; line: number; delta: number } | null = null;
      for (const candidate of candidates) {
        const delta = Math.abs(candidate.value - current);
        if (delta > SNAP_THRESHOLD) continue;
        if (!best || delta < best.delta) {
          best = { ...candidate, delta };
        }
      }
      return best;
    };

    const xCandidates = siblings.flatMap((box) => [
      { value: box.x - width, line: box.x },
      { value: box.x, line: box.x },
      { value: box.x + box.w / 2 - width / 2, line: box.x + box.w / 2 },
      { value: box.x + box.w - width, line: box.x + box.w },
      { value: box.x + box.w, line: box.x + box.w },
    ]);
    const yCandidates = siblings.flatMap((box) => [
      { value: box.y - height, line: box.y },
      { value: box.y, line: box.y },
      { value: box.y + box.h / 2 - height / 2, line: box.y + box.h / 2 },
      { value: box.y + box.h - height, line: box.y + box.h },
      { value: box.y + box.h, line: box.y + box.h },
    ]);

    const snapX = findSnap(snappedLeft, xCandidates);
    const snapY = findSnap(snappedTop, yCandidates);

    if (snapX) {
      snappedLeft = snapX.value;
      lines.push({ type: 'v', pos: snapX.line });
    } else if (showGrid) {
      snappedLeft = Math.round(snappedLeft / GRID_SIZE) * GRID_SIZE;
    }

    if (snapY) {
      snappedTop = snapY.value;
      lines.push({ type: 'h', pos: snapY.line });
    } else if (showGrid) {
      snappedTop = Math.round(snappedTop / GRID_SIZE) * GRID_SIZE;
    }

    snappedLeft = Math.max(0, snappedLeft);
    snappedTop = Math.max(0, snappedTop);

    const deltaX = snappedLeft - left;
    const deltaY = snappedTop - top;
    const nextComponents = cloneState(session.baseComponents);
    const nextById = new Map(nextComponents.map((component) => [component.id, component] as const));

    for (const id of session.selectedIds) {
      const component = nextById.get(id);
      const baseBox = baseBoxes[id];
      if (!component || !baseBox) continue;
      component.props.x = Math.round(baseBox.localX + deltaX);
      component.props.y = Math.round(baseBox.localY + deltaY);
    }

    setComponents(nextComponents);
    setSnapLines(lines);
  }, [showGrid, zoom]);

  const handlePointerUp = useCallback(() => {
    const session = dragRef.current;
    if (!session) return;

    if (session.moved) {
      recordSnapshot(components);
    }
    dragRef.current = null;
    setSnapLines([]);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, [components, recordSnapshot]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => handlePointerMove(event);
    const onUp = () => handlePointerUp();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    const allowedIds = components.map((component) => component.id);
    setSelectedIds((current) => {
      const next = ensureSelectedIds(current, allowedIds);
      return next.length === current.length && next.every((value, index) => value === current[index]) ? current : next;
    });
  }, [components]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if ((mod && event.key.toLowerCase() === 'z' && event.shiftKey) || (mod && event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        redo();
      }
      if (mod && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copySelection();
      }
      if (mod && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelection();
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelectedIds(components.map((component) => component.id));
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedIdsRef.current.length) {
          event.preventDefault();
          deleteSelection();
        }
      }
      if (mod && event.key === '0') {
        event.preventDefault();
        setZoom(100);
      }
      if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setZoom((current) => Math.min(400, current + 25));
      }
      if (mod && event.key === '-') {
        event.preventDefault();
        setZoom((current) => Math.max(25, current - 25));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [copySelection, deleteSelection, duplicateSelection, pasteClipboard, redo, undo, components]);

  if (loading) return <PageSkeleton />;
  if (isMobileView) {
    return <div className="flex min-h-screen items-center justify-center p-6 text-sm text-[color:var(--operator-muted)]">{t('desktopOnly')}</div>;
  }

  const stageScale = zoom / 100;
  const stageWidth = layout.bounds.width;
  const stageHeight = layout.bounds.height;
  const renderedNodes = layout.roots;

  function renderNode(node: MockupResolvedNode, nested = false): ReactNode {
    const isSelected = selectedIds.includes(node.component.id);
    const palette = componentPaletteEntry(node.component.component_type);
    const canContainChildren = componentCanContainChildren(node.component.component_type);
    const padding = getNodePadding(node.component);

    return (
      <div
        key={node.component.id}
        style={nested
          ? {
              position: 'absolute',
              left: node.box.localX,
              top: node.box.localY,
              width: node.box.w,
              height: node.box.h,
              zIndex: node.box.zIndex,
            }
          : mergeBoxStyle(node.box)}
        className="select-none"
      >
        <div
          className={`relative h-full w-full overflow-hidden rounded-2xl border bg-white shadow-sm transition ${isSelected ? 'border-[color:var(--operator-primary)] ring-2 ring-[color:var(--operator-primary)]/25' : 'border-white/10 hover:border-[color:var(--operator-primary)]/18'} ${canContainChildren ? 'bg-[color:var(--operator-panel)]/70' : ''}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            if (event.shiftKey || event.metaKey || event.ctrlKey) {
              event.preventDefault();
              toggleSelection(node.component.id);
              return;
            }
            event.preventDefault();
            beginDrag(node.component.id, event);
          }}
        >
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-slate-500 shadow-sm">
            {palette?.icon ?? '⬚'} {node.component.component_type}
          </div>
          <div className="h-full w-full p-3 pt-7">
            <MockupNodeContent component={node.component} />
          </div>
          {node.component.spec_description ? (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-xl bg-white/80 px-2 py-1 text-[10px] leading-4 text-slate-500 shadow-sm line-clamp-2">
              {node.component.spec_description}
            </div>
          ) : null}
          {selectedIds.length > 1 && isSelected ? (
            <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-[color:var(--operator-primary)] px-2 py-0.5 text-[10px] font-medium text-white shadow-sm">
              ✓
            </div>
          ) : null}
          {node.children.length ? (
            <div className="absolute inset-0" style={{ padding }}>
              {node.children.map((child) => renderNode(child, true))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const panelButtonClass = 'rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-2 text-xs text-[color:var(--operator-foreground)] transition hover:border-[color:var(--operator-primary)]/18 hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <input
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setHasChanges(true);
            }}
            className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[color:var(--operator-panel)] px-4 py-3 text-sm font-semibold text-[color:var(--operator-foreground)] outline-none ring-0 placeholder:text-[color:var(--operator-muted)]"
            placeholder={t('titlePlaceholder')}
          />
          <span className="rounded-full border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-1 text-[11px] text-[color:var(--operator-muted)]">
            {components.length} {t('components')}
          </span>
          <span className={`rounded-full px-3 py-1 text-[11px] ${hasChanges ? 'bg-amber-500/15 text-amber-400' : 'border border-white/10 bg-emerald-500/10 text-emerald-400'}`}>
            {saving ? t('saving') : hasChanges ? t('unsaved') : t('saved')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={panelButtonClass} onClick={() => setZoom((current) => Math.max(25, current - 25))}>-</button>
          <span className="rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-2 text-xs text-[color:var(--operator-muted)]">{zoom}%</span>
          <button type="button" className={panelButtonClass} onClick={() => setZoom((current) => Math.min(400, current + 25))}>+</button>
          <button type="button" className={panelButtonClass} onClick={() => setZoom(100)}>{t('resetZoom')}</button>
          <button type="button" className={panelButtonClass} onClick={() => setShowGrid((current) => !current)}>{showGrid ? t('gridOn') : t('gridOff')}</button>
          <button type="button" className={panelButtonClass} onClick={() => setShowVersions((current) => !current)}>{t('versionHistory')}</button>
          <button type="button" className={panelButtonClass} onClick={() => router.push(`/mockups/${mockupId}`)}>{t('preview')}</button>
          <button type="button" className={panelButtonClass} onClick={undo} disabled={historyPastRef.current.length <= 1}>{t('undo')}</button>
          <button type="button" className={panelButtonClass} onClick={redo} disabled={!historyFutureRef.current.length}>{t('redo')}</button>
          <button type="button" className={panelButtonClass} onClick={() => void copySelection()} disabled={!selectedIds.length}>{t('copy')}</button>
          <button type="button" className={panelButtonClass} onClick={pasteClipboard} disabled={!clipboardRef.current?.selectedIds.length}>{t('paste')}</button>
          <button type="button" className={panelButtonClass} onClick={duplicateSelection} disabled={!selectedIds.length}>{t('duplicate')}</button>
          <button type="button" className={panelButtonClass} onClick={deleteSelection} disabled={!selectedIds.length}>{t('deleteSelected')}</button>
          <button type="button" className={panelButtonClass} onClick={saveMockup} disabled={saving}>{t('save')}</button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        <aside className="rounded-3xl border border-white/10 bg-[color:var(--operator-panel)]/82 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('components')}</div>
              <div className="text-[11px] text-[color:var(--operator-muted)]">{t('treeCanvasSync')}</div>
            </div>
          </div>
          <div className="space-y-2">
            {MOCKUP_PALETTE_ITEMS.map((item) => (
              <button
                key={item.type}
                type="button"
                className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-2 text-left text-xs text-[color:var(--operator-foreground)] transition hover:border-[color:var(--operator-primary)]/18 hover:bg-white/8"
                onClick={() => createComponent(item.type)}
              >
                <span className="flex items-center gap-2"><span>{item.icon}</span> {item.type}</span>
                <span className="text-[10px] text-[color:var(--operator-muted)]">{getDefaultComponentSize(item.type).w}×{getDefaultComponentSize(item.type).h}</span>
              </button>
            ))}
          </div>

          <div className="mt-6">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('scenarios')}</div>
            <div className="space-y-1">
              {scenarios.map((scenario) => (
                <div key={scenario.id} className={`flex items-center gap-2 rounded-2xl px-2 py-1.5 ${activeScenarioId === scenario.id ? 'bg-[color:var(--operator-primary)]/12' : ''}`}>
                  {editingScenarioId === scenario.id ? (
                    <input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onBlur={() => void renameScenario(scenario.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void renameScenario(scenario.id);
                      }}
                      autoFocus
                      className="w-full rounded-xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-2 py-1 text-xs text-[color:var(--operator-foreground)] outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveScenarioId((current) => current === scenario.id ? null : scenario.id)}
                      onDoubleClick={() => {
                        setEditingScenarioId(scenario.id);
                        setEditingName(scenario.name);
                      }}
                      className="flex-1 truncate text-left text-xs text-[color:var(--operator-foreground)]"
                    >
                      {scenario.is_default ? `⭐ ${t('defaultScenario')}` : scenario.name}
                    </button>
                  )}
                  {!scenario.is_default ? (
                    <button type="button" className="text-xs text-rose-300 hover:text-rose-200" onClick={() => void deleteScenario(scenario.id)}>✕</button>
                  ) : null}
                </div>
              ))}
              <button type="button" className="w-full rounded-2xl border border-dashed border-white/12 px-3 py-2 text-xs text-[color:var(--operator-muted)] transition hover:border-[color:var(--operator-primary)]/24 hover:text-[color:var(--operator-primary-soft)]" onClick={() => void addScenario()}>
                + {t('addScenario')}
              </button>
            </div>
          </div>

          <div className="mt-6">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('componentTree')}</div>
            <div className="space-y-0.5">
              {buildTreeNodeRows(renderedNodes).map(({ node, depth }) => (
                <button
                  key={node.component.id}
                  type="button"
                  onClick={(event) => handleTreeSelect(node.component.id, event)}
                  className={`flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-left text-[11px] transition ${selectedIds.includes(node.component.id) ? 'bg-[color:var(--operator-primary)]/12 text-[color:var(--operator-primary-soft)]' : 'text-[color:var(--operator-muted)] hover:bg-white/8'}`}
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                >
                  <span className="text-[10px]">{componentPaletteEntry(node.component.component_type)?.icon ?? '⬚'}</span>
                  <span className="truncate">{node.component.component_type}</span>
                  <span className="ml-auto text-[10px] text-[color:var(--operator-muted)]">z:{node.box.zIndex}</span>
                </button>
              ))}
              {!renderedNodes.length ? <div className="rounded-2xl border border-dashed border-white/12 px-3 py-6 text-center text-xs text-[color:var(--operator-muted)]">{t('dragHere')}</div> : null}
            </div>
          </div>
        </aside>

        <main className="rounded-3xl border border-white/10 bg-[color:var(--operator-panel)]/82 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl" onMouseDown={(event) => {
          if (event.target === event.currentTarget) clearSelection();
        }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--operator-muted)]">
              <span className="rounded-full border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-1">{selectedIds.length ? `${selectedIds.length} ${t('selected')}` : t('selectComponent')}</span>
              {selectedIds.length > 1 ? <span className="rounded-full border border-white/10 bg-[color:var(--operator-surface-soft)]/55 px-3 py-1">{t('multiSelect')}</span> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('left')} disabled={selectedIds.length < 2}>{t('alignLeft')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('centerH')} disabled={selectedIds.length < 2}>{t('alignCenterH')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('right')} disabled={selectedIds.length < 2}>{t('alignRight')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('top')} disabled={selectedIds.length < 2}>{t('alignTop')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('centerV')} disabled={selectedIds.length < 2}>{t('alignCenterV')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyAlignment('bottom')} disabled={selectedIds.length < 2}>{t('alignBottom')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyDistribution('horizontal')} disabled={selectedIds.length < 2}>{t('distributeH')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyDistribution('vertical')} disabled={selectedIds.length < 2}>{t('distributeV')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyLayerAction('bringToFront')} disabled={!selectedIds.length}>{t('bringToFront')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyLayerAction('bringForward')} disabled={!selectedIds.length}>{t('bringForward')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyLayerAction('sendBackward')} disabled={!selectedIds.length}>{t('sendBackward')}</button>
              <button type="button" className={TINY_BUTTON_CLASS} onClick={() => applyLayerAction('sendToBack')} disabled={!selectedIds.length}>{t('sendToBack')}</button>
            </div>
          </div>

          <div className="overflow-auto rounded-[28px] border border-white/8 bg-white p-4 shadow-lg">
            <div
              className="relative rounded-[24px]"
              style={{
                width: stageWidth * stageScale,
                height: stageHeight * stageScale,
              }}
            >
              <div
                className="relative origin-top-left rounded-[24px] bg-white"
                style={{
                  width: stageWidth,
                  height: stageHeight,
                  transform: `scale(${stageScale})`,
                  transformOrigin: 'top left',
                  backgroundImage: showGrid
                    ? 'linear-gradient(to right, rgba(148,163,184,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.16) 1px, transparent 1px)'
                    : undefined,
                  backgroundSize: showGrid ? `${GRID_SIZE}px ${GRID_SIZE}px` : undefined,
                }}
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) clearSelection();
                }}
              >
                {renderedNodes.length ? renderedNodes.map((node) => renderNode(node)) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-8 text-center text-sm text-slate-400 shadow-sm">
                      <div>{t('dragHere')}</div>
                      <div className="mt-1 text-xs text-slate-300">{t('treeCanvasSync')}</div>
                    </div>
                  </div>
                )}
                {snapLines.map((line, index) => (
                  <div
                    key={`${line.type}-${line.pos}-${index}`}
                    className={`pointer-events-none absolute z-50 ${line.type === 'h' ? 'left-0 right-0 h-px bg-rose-500' : 'top-0 bottom-0 w-px bg-rose-500'}`}
                    style={line.type === 'h' ? { top: line.pos } : { left: line.pos }}
                  />
                ))}
              </div>
            </div>
          </div>
        </main>

        <aside className="rounded-3xl border border-white/10 bg-[color:var(--operator-panel)]/82 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl">
          {showVersions ? (
            <div>
              <div className="mb-3 text-sm font-semibold text-[color:var(--operator-foreground)]">{t('versionHistory')}</div>
              <div className="space-y-2">
                {versions.length ? versions.map((version) => (
                  <div key={version.id} className="rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/55 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-medium text-[color:var(--operator-foreground)]">v{version.version}</div>
                        <div className="text-[10px] text-[color:var(--operator-muted)]">{new Date(version.created_at).toLocaleString()}</div>
                      </div>
                      <button type="button" className={TINY_BUTTON_CLASS} onClick={() => void restoreVersion(version.id)}>{t('restore')}</button>
                    </div>
                  </div>
                )) : <div className="rounded-2xl border border-dashed border-white/12 px-3 py-6 text-center text-xs text-[color:var(--operator-muted)]">{t('noVersions')}</div>}
              </div>
            </div>
          ) : selectedComponent ? (
            <div>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-[color:var(--operator-foreground)]">{selectedComponent.component_type}</div>
                  <div className="text-[10px] text-[color:var(--operator-muted)]">{selectedComponent.id}</div>
                </div>
                <button type="button" className={TINY_BUTTON_CLASS} onClick={deleteSelection}>{t('deleteSelected')}</button>
              </div>

              <div className="space-y-2">
                {Object.entries(selectedComponent.props).map(([key, value]) => (
                  <div key={key}>
                    <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">{key}</label>
                    <input
                      type={typeof value === 'number' ? 'number' : 'text'}
                      value={typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '')}
                      onChange={(event) => updateSelectedProp(key, event.target.value)}
                      className="w-full rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-3 py-2 text-xs text-[color:var(--operator-foreground)] outline-none"
                    />
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--operator-muted)]">{t('specDescription')}</label>
                <textarea
                  value={selectedComponent.spec_description ?? ''}
                  onChange={(event) => updateSelectedSpec(event.target.value)}
                  rows={5}
                  className="w-full rounded-2xl border border-white/10 bg-[color:var(--operator-surface-soft)] px-3 py-2 text-xs text-[color:var(--operator-foreground)] outline-none"
                  placeholder={t('markdownPlaceholder')}
                />
              </div>

              {activeScenarioId ? (
                (() => {
                  const scenario = scenarios.find((item) => item.id === activeScenarioId);
                  if (!scenario) return null;
                  const overrides = scenario.override_props[selectedComponent.id] ?? {};
                  return (
                    <div className="mt-4 rounded-2xl border border-[color:var(--operator-primary)]/20 bg-[color:var(--operator-primary)]/10 p-3">
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--operator-primary-soft)]">
                        {scenario.is_default ? t('defaultScenario') : scenario.name} {t('overrides')}
                      </div>
                      <div className="space-y-2">
                        {Object.keys(selectedComponent.props).map((key) => (
                          <div key={key}>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--operator-primary-soft)]">{key}</label>
                            <input
                              value={String(overrides[key] ?? '')}
                              placeholder={String(selectedComponent.props[key] ?? '')}
                              onChange={async (event) => {
                                const nextOverrides = { ...scenario.override_props, [selectedComponent.id]: { ...overrides, [key]: event.target.value || undefined } };
                                const cleaned = Object.fromEntries(Object.entries(nextOverrides[selectedComponent.id] ?? {}).filter(([, value]) => value !== undefined && value !== ''));
                                if (Object.keys(cleaned).length === 0) {
                                  delete nextOverrides[selectedComponent.id];
                                } else {
                                  nextOverrides[selectedComponent.id] = cleaned;
                                }
                                await saveScenarioOverrides(activeScenarioId, nextOverrides);
                              }}
                              className="w-full rounded-2xl border border-white/10 bg-[color:var(--operator-panel)] px-3 py-2 text-xs text-[color:var(--operator-foreground)] outline-none"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/12 px-3 py-6 text-center text-sm text-[color:var(--operator-muted)]">
              {t('selectComponent')}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
