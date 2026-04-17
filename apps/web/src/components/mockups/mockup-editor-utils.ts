export interface MockupComponent {
  id: string;
  parent_id: string | null;
  component_type: string;
  props: Record<string, unknown>;
  spec_description: string | null;
  sort_order: number;
}

export interface MockupScenario {
  id: string;
  name: string;
  override_props: Record<string, Record<string, unknown>>;
  is_default: boolean;
}

export interface MockupPaletteItem {
  type: string;
  icon: string;
  defaultProps: Record<string, unknown>;
}

export interface MockupResolvedBox {
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  localX: number;
  localY: number;
  parentOriginX: number;
  parentOriginY: number;
  parent_id: string | null;
}

export type MockupResolvedBoxMap = Record<string, MockupResolvedBox>;

export interface MockupResolvedNode {
  component: MockupComponent;
  box: MockupResolvedBox;
  children: MockupResolvedNode[];
}

export interface MockupResolvedLayout {
  roots: MockupResolvedNode[];
  boxesById: MockupResolvedBoxMap;
  bounds: { width: number; height: number };
}

export type MockupAlignmentAxis = 'left' | 'right' | 'top' | 'bottom' | 'centerH' | 'centerV';
export type MockupDistributionAxis = 'horizontal' | 'vertical';
export type MockupLayerAction = 'bringToFront' | 'sendToBack' | 'bringForward' | 'sendBackward';

export const MOCKUP_PALETTE_ITEMS: MockupPaletteItem[] = [
  { type: 'Button', icon: '🔘', defaultProps: { text: 'Button', variant: 'primary' } },
  { type: 'Input', icon: '📝', defaultProps: { placeholder: 'Enter text...' } },
  { type: 'Card', icon: '🃏', defaultProps: { padding: 16, borderRadius: 16 } },
  { type: 'Container', icon: '📦', defaultProps: { display: 'flex', flexDirection: 'column', gap: 8, padding: 16 } },
  { type: 'Text', icon: '📄', defaultProps: { text: 'Text content' } },
  { type: 'Image', icon: '🖼', defaultProps: { src: '', alt: 'Image', width: '100%' } },
  { type: 'Table', icon: '📊', defaultProps: { rows: 3, cols: 3 } },
  { type: 'Badge', icon: '🏷', defaultProps: { text: 'Badge', color: '#3b82f6' } },
  { type: 'Alert', icon: '⚠️', defaultProps: { text: 'Alert message', type: 'info' } },
];

const DEFAULT_SIZE_BY_TYPE: Record<string, { w: number; h: number }> = {
  Button: { w: 120, h: 40 },
  Input: { w: 240, h: 40 },
  Card: { w: 320, h: 220 },
  Container: { w: 360, h: 240 },
  Text: { w: 220, h: 32 },
  Image: { w: 240, h: 160 },
  Table: { w: 360, h: 220 },
  Badge: { w: 96, h: 32 },
  Alert: { w: 280, h: 56 },
};

const TYPE_WITH_CHILDREN = new Set(['Container', 'Card']);

function toNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

function cloneProps<T extends Record<string, unknown>>(props: T): T {
  return JSON.parse(JSON.stringify(props ?? {})) as T;
}

function cloneComponent(component: MockupComponent): MockupComponent {
  return {
    ...component,
    props: cloneProps(component.props),
  };
}

function sortByOrder(list: MockupComponent[]) {
  return [...list].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}

function groupChildren(components: MockupComponent[]) {
  const groups = new Map<string | null, MockupComponent[]>();
  for (const component of components) {
    const key = component.parent_id ?? null;
    const bucket = groups.get(key) ?? [];
    bucket.push(component);
    groups.set(key, bucket);
  }
  for (const [key, bucket] of groups) {
    groups.set(key, sortByOrder(bucket));
  }
  return groups;
}

function getDefaultSize(componentType: string) {
  return DEFAULT_SIZE_BY_TYPE[componentType] ?? { w: 220, h: 56 };
}

function getPadding(component: MockupComponent) {
  const raw = component.props.padding;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return TYPE_WITH_CHILDREN.has(component.component_type) ? 16 : 12;
}

function getLocalBox(component: MockupComponent, index: number, parentId: string | null, parentOriginX: number, parentOriginY: number) {
  const defaultSize = getDefaultSize(component.component_type);
  const w = toNumber(component.props.w, defaultSize.w);
  const h = toNumber(component.props.h, defaultSize.h);
  const hasExplicitX = typeof component.props.x === 'number' && Number.isFinite(component.props.x);
  const hasExplicitY = typeof component.props.y === 'number' && Number.isFinite(component.props.y);
  const padding = parentId === null ? 0 : 16;
  const gap = parentId === null ? 40 : 12;
  const columns = parentId === null ? 2 : 1;

  const fallbackLocalX = parentId === null
    ? 40 + (index % columns) * (defaultSize.w + 48)
    : padding;
  const fallbackLocalY = parentId === null
    ? 40 + Math.floor(index / columns) * (defaultSize.h + 56)
    : padding + index * (h + gap);

  const localX = hasExplicitX ? toNumber(component.props.x, fallbackLocalX) : fallbackLocalX;
  const localY = hasExplicitY ? toNumber(component.props.y, fallbackLocalY) : fallbackLocalY;
  const zIndex = toNumber(component.props.zIndex, 0);

  return {
    x: parentOriginX + localX,
    y: parentOriginY + localY,
    w,
    h,
    zIndex,
    localX,
    localY,
  };
}

function measureBounds(nodes: MockupResolvedNode[]) {
  let maxX = 0;
  let maxY = 0;
  for (const node of nodes) {
    maxX = Math.max(maxX, node.box.x + node.box.w);
    maxY = Math.max(maxY, node.box.y + node.box.h);
    const childBounds = measureBounds(node.children);
    maxX = Math.max(maxX, childBounds.width);
    maxY = Math.max(maxY, childBounds.height);
  }
  return { width: maxX, height: maxY };
}

function resolveLevel(groups: Map<string | null, MockupComponent[]>, parentId: string | null, parentOriginX: number, parentOriginY: number): MockupResolvedNode[] {
  const siblings = groups.get(parentId) ?? [];
  return siblings.map((component, index) => {
    const local = getLocalBox(component, index, parentId, parentOriginX, parentOriginY);
    const padding = getPadding(component);
    const childOriginX = local.x + padding;
    const childOriginY = local.y + padding;
    const children = resolveLevel(groups, component.id, childOriginX, childOriginY);
    const childBounds = measureBounds(children);

    const explicitWidth = typeof component.props.w === 'number' && Number.isFinite(component.props.w);
    const explicitHeight = typeof component.props.h === 'number' && Number.isFinite(component.props.h);
    const w = explicitWidth ? local.w : Math.max(local.w, childBounds.width > 0 ? childBounds.width - local.x + padding : local.w);
    const h = explicitHeight ? local.h : Math.max(local.h, childBounds.height > 0 ? childBounds.height - local.y + padding : local.h);

    const box = {
      x: local.x,
      y: local.y,
      w,
      h,
      zIndex: local.zIndex,
      localX: local.localX,
      localY: local.localY,
      parentOriginX,
      parentOriginY,
      parent_id: parentId,
    };

    return {
      component,
      box,
      children,
    };
  });
}

export function resolveMockupLayout(components: MockupComponent[]): MockupResolvedLayout {
  const groups = groupChildren(components);
  const roots = resolveLevel(groups, null, 0, 0);
  const boxesById: MockupResolvedBoxMap = {};

  const visit = (nodes: MockupResolvedNode[]) => {
    for (const node of nodes) {
      boxesById[node.component.id] = node.box;
      visit(node.children);
    }
  };

  visit(roots);
  const bounds = measureBounds(roots);
  return { roots, boxesById, bounds: { width: Math.max(1200, bounds.width + 160), height: Math.max(900, bounds.height + 160) } };
}

export function componentCanContainChildren(componentType: string) {
  return TYPE_WITH_CHILDREN.has(componentType);
}

export function getDefaultComponentSize(componentType: string) {
  return getDefaultSize(componentType);
}

export function reindexComponentSortOrder(components: MockupComponent[]) {
  const next = components.map(cloneComponent);
  const groups = groupChildren(next);
  for (const siblings of groups.values()) {
    siblings.forEach((component, index) => {
      component.sort_order = index;
    });
  }
  return next;
}

export function removeComponentsByIds(components: MockupComponent[], ids: string[]) {
  const removeSet = new Set(ids);
  const groups = groupChildren(components);
  const queue = [...removeSet];

  while (queue.length) {
    const currentId = queue.pop()!;
    for (const child of groups.get(currentId) ?? []) {
      if (!removeSet.has(child.id)) {
        removeSet.add(child.id);
        queue.push(child.id);
      }
    }
  }

  return reindexComponentSortOrder(components.filter((component) => !removeSet.has(component.id)));
}

function buildSelectionClosure(components: MockupComponent[], selectedIds: string[]) {
  const groups = groupChildren(components);
  const includeSet = new Set<string>();
  const queue = [...selectedIds];

  while (queue.length) {
    const currentId = queue.pop()!;
    if (includeSet.has(currentId)) continue;
    includeSet.add(currentId);
    for (const child of groups.get(currentId) ?? []) {
      queue.push(child.id);
    }
  }

  return includeSet;
}
export function extractSelectedComponents(components: MockupComponent[], selectedIds: string[]) {
  const includeSet = buildSelectionClosure(components, selectedIds);
  const ordered = components.filter((component) => includeSet.has(component.id));
  const selectedSet = new Set(selectedIds);
  return {
    components: ordered.map(cloneComponent),
    selectedIds: ordered.filter((component) => selectedSet.has(component.id)).map((component) => component.id),
  };
}


export function duplicateSelectedComponents(
  components: MockupComponent[],
  boxesById: MockupResolvedBoxMap,
  selectedIds: string[],
  options?: {
    offsetX?: number;
    offsetY?: number;
    idFactory?: (sourceId: string, index: number) => string;
  },
) {
  const uniqueSelectedIds = Array.from(new Set(selectedIds));
  const includeSet = buildSelectionClosure(components, uniqueSelectedIds);
  const idFactory = options?.idFactory ?? ((sourceId: string, index: number) => `copy-${Date.now().toString(36)}-${index}-${sourceId}`);
  const offsetX = options?.offsetX ?? 24;
  const offsetY = options?.offsetY ?? 24;
  const orderedIncluded = components.filter((component) => includeSet.has(component.id));
  const idMap = new Map<string, string>();

  orderedIncluded.forEach((component, index) => {
    idMap.set(component.id, idFactory(component.id, index));
  });

  const clones = orderedIncluded.map((component) => {
    const box = boxesById[component.id];
    const parentIncluded = component.parent_id ? includeSet.has(component.parent_id) : false;
    const parent_id = parentIncluded ? (component.parent_id ? idMap.get(component.parent_id) ?? null : null) : null;
    const clone: MockupComponent = {
      ...cloneComponent(component),
      id: idMap.get(component.id)!,
      parent_id,
      props: cloneProps(component.props),
      sort_order: component.sort_order,
    };

    if (!parentIncluded) {
      const sourceX = box?.x ?? toNumber(component.props.x, 0);
      const sourceY = box?.y ?? toNumber(component.props.y, 0);
      clone.props.x = sourceX + offsetX;
      clone.props.y = sourceY + offsetY;
    } else {
      clone.props.x = box?.localX ?? toNumber(component.props.x, 0);
      clone.props.y = box?.localY ?? toNumber(component.props.y, 0);
    }

    if (box) {
      clone.props.w = box.w;
      clone.props.h = box.h;
      clone.props.zIndex = box.zIndex;
    }

    return clone;
  });

  const next = reindexComponentSortOrder([...components, ...clones]);
  return {
    components: next,
    selectedIds: uniqueSelectedIds.map((sourceId) => idMap.get(sourceId)!).filter(isDefined),
  };
}

function groupSelectedByParent(components: MockupComponent[], selectedIds: string[]) {
  const componentById = new Map(components.map((component) => [component.id, component] as const));
  const groups = new Map<string | null, string[]>();
  for (const id of selectedIds) {
    const component = componentById.get(id);
    if (!component) continue;
    const bucket = groups.get(component.parent_id ?? null) ?? [];
    bucket.push(id);
    groups.set(component.parent_id ?? null, bucket);
  }
  return groups;
}

function updateBoxesForGroup(
  components: MockupComponent[],
  boxesById: MockupResolvedBoxMap,
  ids: string[],
  updater: (component: MockupComponent, box: MockupResolvedBox) => void,
) {
  const byId = new Map(components.map((component) => [component.id, component] as const));
  for (const id of ids) {
    const component = byId.get(id);
    const box = boxesById[id];
    if (!component || !box) continue;
    updater(component, box);
  }
}

export function alignSelectedComponents(
  components: MockupComponent[],
  boxesById: MockupResolvedBoxMap,
  selectedIds: string[],
  axis: MockupAlignmentAxis,
) {
  if (selectedIds.length < 2) return components;
  const groups = groupSelectedByParent(components, selectedIds);
  const next = components.map(cloneComponent);
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const boxes = ids.map((id) => boxesById[id]).filter(isDefined);
    if (boxes.length < 2) continue;

    if (axis === 'left') {
      const target = Math.min(...boxes.map((box) => box.x));
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.x = target - box.parentOriginX;
      });
    }

    if (axis === 'right') {
      const target = Math.max(...boxes.map((box) => box.x + box.w));
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.x = target - box.parentOriginX - box.w;
      });
    }

    if (axis === 'top') {
      const target = Math.min(...boxes.map((box) => box.y));
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.y = target - box.parentOriginY;
      });
    }

    if (axis === 'bottom') {
      const target = Math.max(...boxes.map((box) => box.y + box.h));
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.y = target - box.parentOriginY - box.h;
      });
    }

    if (axis === 'centerH') {
      const target = boxes.reduce((sum, box) => sum + box.x + box.w / 2, 0) / boxes.length;
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.x = Math.round(target - box.parentOriginX - box.w / 2);
      });
    }

    if (axis === 'centerV') {
      const target = boxes.reduce((sum, box) => sum + box.y + box.h / 2, 0) / boxes.length;
      updateBoxesForGroup(next, boxesById, ids, (component, box) => {
        component.props.y = Math.round(target - box.parentOriginY - box.h / 2);
      });
    }
  }

  return next;
}

export function distributeSelectedComponents(
  components: MockupComponent[],
  boxesById: MockupResolvedBoxMap,
  selectedIds: string[],
  axis: MockupDistributionAxis,
) {
  if (selectedIds.length < 2) return components;
  const groups = groupSelectedByParent(components, selectedIds);
  const next = components.map(cloneComponent);
  const byId = new Map(next.map((component) => [component.id, component] as const));
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const boxes = ids.map((id) => boxesById[id]).filter(isDefined);
    if (boxes.length < 2) continue;

    const sortedIds = [...ids].sort((a, b) => {
      const boxA = boxesById[a];
      const boxB = boxesById[b];
      if (!boxA || !boxB) return 0;
      return axis === 'horizontal' ? boxA.x - boxB.x : boxA.y - boxB.y;
    });

    if (axis === 'horizontal') {
      const sortedBoxes = sortedIds.map((id) => boxesById[id]).filter(isDefined);
      const start = sortedBoxes[0].x;
      const end = sortedBoxes[sortedBoxes.length - 1].x + sortedBoxes[sortedBoxes.length - 1].w;
      const totalWidth = sortedBoxes.reduce((sum, box) => sum + box.w, 0);
      const gap = sortedBoxes.length > 1 ? (end - start - totalWidth) / (sortedBoxes.length - 1) : 0;
      let cursor = start;
      sortedIds.forEach((id, index) => {
        const box = boxesById[id];
        const component = byId.get(id);
        if (!box || !component) return;
        component.props.x = Math.round(cursor - box.parentOriginX);
        cursor += box.w + gap;
        if (index === sortedIds.length - 1) {
          cursor = end;
        }
      });
    }

    if (axis === 'vertical') {
      const sortedBoxes = sortedIds.map((id) => boxesById[id]).filter(isDefined);
      const start = sortedBoxes[0].y;
      const end = sortedBoxes[sortedBoxes.length - 1].y + sortedBoxes[sortedBoxes.length - 1].h;
      const totalHeight = sortedBoxes.reduce((sum, box) => sum + box.h, 0);
      const gap = sortedBoxes.length > 1 ? (end - start - totalHeight) / (sortedBoxes.length - 1) : 0;
      let cursor = start;
      sortedIds.forEach((id, index) => {
        const box = boxesById[id];
        const component = byId.get(id);
        if (!box || !component) return;
        component.props.y = Math.round(cursor - box.parentOriginY);
        cursor += box.h + gap;
        if (index === sortedIds.length - 1) {
          cursor = end;
        }
      });
    }
  }

  return next;
}

export function updateSelectedLayerOrder(
  components: MockupComponent[],
  boxesById: MockupResolvedBoxMap,
  selectedIds: string[],
  action: MockupLayerAction,
) {
  if (!selectedIds.length) return components;
  const groups = groupSelectedByParent(components, selectedIds);
  const next = components.map(cloneComponent);
  const byId = new Map(next.map((component) => [component.id, component] as const));
  for (const [parentId, ids] of groups.entries()) {
    if (!ids.length) continue;
    const siblingIds = next
      .filter((component) => (component.parent_id ?? null) === parentId)
      .map((component) => component.id);
    const siblingBoxes = siblingIds.map((id) => boxesById[id]).filter(isDefined);
    if (!siblingBoxes.length) continue;

    const sortedSiblingIds = [...siblingIds].sort((a, b) => {
      const boxA = boxesById[a];
      const boxB = boxesById[b];
      if (!boxA || !boxB) return 0;
      return boxA.zIndex - boxB.zIndex || boxA.y - boxB.y || boxA.x - boxB.x;
    });
    const selectedSet = new Set(ids);
    const orderedSelectedIds = sortedSiblingIds.filter((id) => selectedSet.has(id));

    if (action === 'bringForward') {
      orderedSelectedIds.forEach((id) => {
        const component = byId.get(id);
        if (!component) return;
        component.props.zIndex = toNumber(component.props.zIndex, 0) + 1;
      });
    }

    if (action === 'sendBackward') {
      orderedSelectedIds.forEach((id) => {
        const component = byId.get(id);
        if (!component) return;
        component.props.zIndex = toNumber(component.props.zIndex, 0) - 1;
      });
    }

    if (action === 'bringToFront') {
      const max = Math.max(...siblingBoxes.map((box) => box.zIndex));
      orderedSelectedIds.forEach((id, index) => {
        const component = byId.get(id);
        if (!component) return;
        component.props.zIndex = max + index + 1;
      });
    }

    if (action === 'sendToBack') {
      const min = Math.min(...siblingBoxes.map((box) => box.zIndex));
      orderedSelectedIds.forEach((id, index) => {
        const component = byId.get(id);
        if (!component) return;
        component.props.zIndex = min - orderedSelectedIds.length + index;
      });
    }
  }

  return next;
}

export function cloneMockupComponents(components: MockupComponent[]) {
  return components.map(cloneComponent);
}

export function ensureSelectedIds(selectedIds: string[], allowedIds: string[]) {
  const allowedSet = new Set(allowedIds);
  return selectedIds.filter((id) => allowedSet.has(id));
}
