import { compareServerOrder, planMoveInto, planReorder, siblingsInServerOrder, type DocMovePlan as DocPlacement } from '../doc-move-plan';

/**
 * story #4348 — 문서 트리에서 키보드 · 터치로 문서 자리를 옮긴다(«⋮» 메뉴: 위로 · 아래로 · 폴더로). 끌기는 마우스 전용이라
 * (센서가 터치를 안 받음 #1988 · 키보드 센서 없음) 키보드 · 보조기기 · 터치 사용자는 문서 순서 · 위치를 바꿀 길이 0이었다.
 *
 * **자리 계산은 한 모듈**(`components/docs/doc-move-plan.ts` · 4353): 형제 순서(siblingsInServerOrder) · 어디에 놓나(planReorder · planMoveInto) ·
 * 요청 본문(reorderRequestBody). 이 파일은 그 위의 **메뉴 층**만 — 켜고 끄기 · 거부 까닭 · 고르개 목록 · 낙관 반영 · 알림. 끌기 길과 메뉴 길이
 * 같은 요청 본문을 보낸다(같은 계획 함수 · doc-move.test.ts «같은 길»).
 *
 * 이 파일은 **계산만** 한다(저장 API와 무관): 옮긴 뒤의 새 부모 · 그 부모 아래 형제들의 새 순서(id 목록) · 경계 · 거부 까닭.
 * - 형제 순서는 서버 목록과 같은 `(sort_order, id)` 복합 정렬이다(backend `repositories/doc.py` — sort_order는 기본값 0이 대부분이라
 *   같은 값끼리는 id로 갈린다). 트리 렌더(수동 순서)도 서버가 준 이 순서를 그대로 쓴다.
 * - 저장은 새 BE API(4353 · PO 23:01Z 모양 (가))다: 본문 `{ doc_id, parent_id, after_id? }` = `reorderRequestBody(plan.placement)`(doc-move-plan.ts) — 옮긴 문서 하나와
 *   바로 앞 이웃만 말한다(트리는 20개씩 페이지로 받아 형제 **전부**는 모를 수 있지만, 받은 목록은 늘 전체의 앞부분이라 이웃은 확실히 앎).
 *   문서마다 PATCH로 번호를 다시 매기는 길은 버렸다(형제 1,295/1,305가 sort_order 0 → 끌기 순서 저장이 사실상 무효였던 원인이 PATCH가 형제를 다시 안 매기는 것).
 */
export interface MovableDoc {
  id: string;
  parent_id: string | null;
  sort_order: number;
  title: string;
  is_folder?: boolean;
}

export type DocMoveAction = { kind: 'up' } | { kind: 'down' } | { kind: 'into'; parentId: string | null };

export type DocMoveDenied = 'not-found' | 'boundary' | 'circular' | 'same-place' | 'not-folder';

/** 메뉴 옮기기 계획 — `placement` = 서버에 보낼 자리(doc-move-plan.ts가 짠 것 그대로) · 나머지는 낙관 반영 · 알림용. */
export type MenuMovePlan =
  | { ok: true; docId: string; fromParentId: string | null; parentId: string | null; orderedIds: string[]; index: number; placement: DocPlacement }
  | { ok: false; reason: DocMoveDenied };

/** `nodeId`가 `ancestorId`의 자손인가(자기 자신 포함 아님) — 폴더 안으로 옮길 때 순환 거부용. */
function isUnder(docs: MovableDoc[], ancestorId: string, nodeId: string): boolean {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let cur = byId.get(nodeId)?.parent_id ?? null;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return false;
}

/** 메뉴 항목 켜고 끄기 — 맨 위면 «위로» · 맨 아래면 «아래로»가 꺼진다. */
export function moveBounds(docs: MovableDoc[], docId: string): { up: boolean; down: boolean } {
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return { up: false, down: false };
  const siblings = siblingsInServerOrder(docs, doc.parent_id ?? null);
  const i = siblings.findIndex((d) => d.id === docId);
  return { up: i > 0, down: i >= 0 && i < siblings.length - 1 };
}

/** 고르개 한 줄 — `id` null = 맨 위 단계 · `depth` = 트리 깊이(들여쓰기) · `current` = 지금 있는 자리(누를 수 없음 · aria-current="location"). */
export interface MoveTarget { id: string | null; depth: number; current: boolean }

/**
 * «폴더로 옮기기» 고르개 목록 — **트리와 같은 깊이 우선 순서**(유나 #4730 첫 판: 전체 sort_order 순 · 들여쓰기 0이라 하위 폴더가 부모 위에 오고,
 * 같은 이름이 다른 부모 밑에 있으면 못 가렸다).
 * - 맨 위 단계가 늘 첫 줄(깊이 0) → 폴더들을 트리 순서(`compare` · 트리 보기와 같은 비교)로 부모 → 자식 차례로. 맨 위 폴더 = 깊이 1(유나 확정 01:43Z).
 * - 자기 자신과 그 아래는 빠진다(순환). 트리에 안 보이는 폴더(부모를 아직 안 받음)도 빠진다 — 트리가 안 그리는 자리.
 * - 지금 있는 자리(부모 폴더 · 루트면 맨 위 단계)는 빼지 않고 `current`로 남긴다: 빼면 그 아래 폴더가 엉뚱한 줄 밑으로 들여써져 트리 모양이 깨진다.
 */
export function moveTargets<T extends MovableDoc>(docs: T[], docId: string, compare: (a: T, b: T) => number = compareServerOrder): MoveTarget[] {
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return [];
  const here = doc.parent_id ?? null;
  const out: MoveTarget[] = [{ id: null, depth: 0, current: here === null }];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    const kids = docs.filter((d) => d.is_folder && d.id !== docId && (d.parent_id ?? null) === parentId).sort(compare);
    for (const f of kids) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, depth, current: f.id === here });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** 옮기기 계획 — 위로 · 아래로는 같은 부모 안에서 한 칸 바꾸기(끌기의 planReorder와 같은 함수), 폴더로는 그 폴더 끝(planMoveInto). */
export function planDocMove(docs: MovableDoc[], docId: string, action: DocMoveAction): MenuMovePlan {
  const doc = docs.find((d) => d.id === docId);
  if (!doc) return { ok: false, reason: 'not-found' };
  const from = doc.parent_id ?? null;
  if (action.kind === 'up' || action.kind === 'down') {
    const ids = siblingsInServerOrder(docs, from).map((d) => d.id);
    const i = ids.indexOf(docId);
    const j = action.kind === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return { ok: false, reason: 'boundary' };
    // 끌기로 이웃 위에 놓는 것과 같은 계획(아래로 = 그 이웃 뒤 · 위로 = 그 이웃 앞) — 두 길이 같은 요청 본문.
    const placement = planReorder(docs, docId, ids[j]!);
    if (!placement) return { ok: false, reason: 'boundary' };
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return { ok: true, docId, fromParentId: from, parentId: from, orderedIds: ids, index: j, placement };
  }
  const to = action.parentId;
  if (to === from) return { ok: false, reason: 'same-place' };
  if (to !== null) {
    const target = docs.find((d) => d.id === to);
    if (!target || !target.is_folder) return { ok: false, reason: 'not-folder' };
    if (to === docId || isUnder(docs, docId, to)) return { ok: false, reason: 'circular' };
  }
  const ids = [...siblingsInServerOrder(docs, to).map((d) => d.id), docId];
  return { ok: true, docId, fromParentId: from, parentId: to, orderedIds: ids, index: ids.length - 1, placement: planMoveInto(docId, to) };
}

/** 옮긴 결과를 로컬 트리에 바로 반영(낙관) — 새 부모 · 간격 번호. 저장 실패면 호출부가 서버 트리로 되돌린다. */
export function applyDocMove<T extends MovableDoc>(docs: T[], plan: Extract<MenuMovePlan, { ok: true }>, step = 10): T[] {
  const order = new Map(plan.orderedIds.map((id, i) => [id, (i + 1) * step]));
  return docs.map((d) => {
    if (!order.has(d.id)) return d;
    return { ...d, sort_order: order.get(d.id)!, ...(d.id === plan.docId ? { parent_id: plan.parentId } : {}) };
  });
}

/**
 * 옮긴 뒤 스크린리더 알림(aria-live) — 문구 키와 값만 돌려준다(문구 자체는 i18n `docs.*` · 유나 확정 뒤 싣는다).
 * - 위로 · 아래로: 형제 중 몇 번째인지(«N개 중 M번째»)
 * - 폴더로: 새 폴더 이름 · 맨 위 단계로: 단계만
 */
/**
 * 알림 종류 · 값 — 문구 키는 소비처(doc-tree.tsx)의 `Record<string, string>` 리터럴 표가 고른다(PO 2026-09-27 17:04Z):
 * 키 이름을 여기서 돌려주고 `t(a.key)`로 읽으면 i18n 가드(verify:no-unused-i18n-keys)가 그 키를 못 알아봐 «안 쓰는 키»로 잡는다.
 * 가드가 알아보는 모양은 ns를 여는 파일 안 `Record<string, string>` 표 값(A″)이다.
 */
export type DocMoveAnnouncement =
  | { kind: 'position'; values: { title: string; position: number; total: number } }
  | { kind: 'positionOnly'; values: { title: string; position: number } }
  | { kind: 'intoFolder'; values: { title: string; folder: string } }
  | { kind: 'topLevel'; values: { title: string } };

/** 옮긴 자리(서버 기준) — 새 부모의 형제 **전부** 중 몇 번째인지 · 몇 개인지. 트리는 20개씩 받아서 불러온 형제 수로는 전체를 말할 수 없다(까디르 #4730 P3). */
export interface DocMovePlaced { position: number; total: number }

/**
 * 저장 응답(`{doc, siblings}` · 4353이 새 부모의 형제 전부를 돌려줌)에서 자리를 센다. 응답의 형제 목록에 옮긴 문서가 없으면 `doc`을 넣어 센다.
 * 서버와 같은 `(sort_order, id)` 순서. 옮긴 문서를 못 찾으면 null(→ «M번째»만 말함).
 */
export function placedFromSiblings(doc: { id: string; sort_order: number }, siblings: Array<{ id: string; sort_order: number }>): DocMovePlaced | null {
  const all = siblings.some((d) => d.id === doc.id) ? [...siblings] : [...siblings, doc];
  all.sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const i = all.findIndex((d) => d.id === doc.id);
  return i < 0 ? null : { position: i + 1, total: all.length };
}

/** 호출부(레이아웃 handleMenuMove)가 돌려주는 것 — 거부면 `{ plan(ok:false), placed: null }` · 성공이면 계획 + 서버 자리 · 저장 실패면 null. */
export type MenuMoveResult = { plan: MenuMovePlan; placed: DocMovePlaced | null } | null;

/**
 * 위로 · 아래로 알림: 서버 자리(`placed`)를 알면 «N개 중 M번째», 모르면 «M번째»만 — 불러온 형제 수(N)로 전체를 단정하지 않는다.
 * M은 계획의 자리로도 맞다(불러온 쪽은 늘 전체 순서의 앞부분).
 */
export function docMoveAnnouncement(docs: MovableDoc[], plan: Extract<MenuMovePlan, { ok: true }>, placed: DocMovePlaced | null = null): DocMoveAnnouncement {
  const title = docs.find((d) => d.id === plan.docId)?.title ?? '';
  if (plan.parentId === plan.fromParentId) {
    return placed
      ? { kind: 'position', values: { title, position: placed.position, total: placed.total } }
      : { kind: 'positionOnly', values: { title, position: plan.index + 1 } };
  }
  if (plan.parentId === null) return { kind: 'topLevel', values: { title } };
  return { kind: 'intoFolder', values: { title, folder: docs.find((d) => d.id === plan.parentId)?.title ?? '' } };
}

/**
 * «⋮» 메뉴 항목 상태(PO · 유나 2026-09-26 22:57~58Z):
 * - 이름순 · 수정일순 보기(`sortMode !== 'manual'`)에선 **위로 · 아래로를 끈다**(수동 순서가 의미 없는 보기 · 끌기가 `moveSortModeActiveError`로
 *   막히는 것과 같은 규칙). 숨기지 않고 `aria-disabled`(초점 닿음) + 까닭 줄(`sortLocked`)로.
 * - 맨 위면 위로 · 맨 아래면 아래로도 끈다(수동 보기에서도).
 * - 폴더로 이동은 정렬과 무관하게 켜 둔다(옮길 폴더가 있을 때).
 */
/**
 * story #4376(유나 4766 반려) — **실효 부모** 한 규칙: 부모가 이 목록에 없는 문서(부모가 지워짐 · 태그 필터로 부모가 빠짐)는 뿌리 문서로 본다.
 * 트리는 그런 문서를 뿌리에 그리므로, 끌어 놓기 계획 · «⋮» 위로/아래로/옮기기도 같은 목록으로 짜야 뿌리 기준이 된다 — 예전엔 그리기만 뿌리이고
 * 계획은 숨은 부모 id를 요청에 실어, 부모가 지워졌으면 reorder 404, 태그 필터 중이면 보이지 않는 진짜 폴더로 들어갔다.
 * 바뀐 문서가 없으면 같은 배열을 돌려준다(메모 · 참조 비교 그대로).
 */
export function withEffectiveParents<T extends { id: string; parent_id: string | null }>(docs: T[]): T[] {
  const ids = new Set(docs.map((d) => d.id));
  let changed = false;
  const out = docs.map((d) => {
    if (!d.parent_id || ids.has(d.parent_id)) return d;
    changed = true;
    return { ...d, parent_id: null };
  });
  return changed ? out : docs;
}

export function menuMoveState<T extends MovableDoc>(docs: T[], docId: string, sortMode: 'manual' | 'title' | 'updated_at', hasMore = false, compare: (a: T, b: T) => number = compareServerOrder, filtered = false): {
  up: boolean; down: boolean; sortLocked: boolean; filterLocked: boolean; downUnloaded: boolean; targets: MoveTarget[];
} {
  // story #4376(유나 · PO 확정) — 태그 필터가 켜진 동안(걸러 낸 부분 보기)엔 옮기기 전부 끔: 보이는 형제만으로 순서를 저장하면 안 보이는 형제
  // 사이로 들어간다. 까닭 줄은 정렬 까닭보다 먼저.
  if (filtered) return { up: false, down: false, sortLocked: false, filterLocked: true, downUnloaded: false, targets: [] };
  const manual = sortMode === 'manual';
  const b = moveBounds(docs, docId);
  // 아래로 = 다음 형제 뒤. 받은 형제 중 마지막인데 트리에 아직 안 받은 문서가 있으면(hasMore), 다음 형제가 안 받은 자리일 수 있어 끈다(PO 23:01Z).
  const doc = docs.find((d) => d.id === docId);
  const siblings = doc ? siblingsInServerOrder(docs, doc.parent_id ?? null) : [];
  const lastLoaded = siblings.length > 0 && siblings[siblings.length - 1].id === docId;
  const downUnloaded = manual && hasMore && lastLoaded;
  // downUnloaded면 받은 형제 중 마지막이라 b.down이 이미 거짓이다(«아래로»를 끄는 건 moveBounds) — downUnloaded는 까닭 줄을 고르는 데만 쓴다(러너 e M18 동등).
  return { up: manual && b.up, down: manual && b.down, sortLocked: !manual, filterLocked: false, downUnloaded, targets: moveTargets(docs, docId, compare) };
}
