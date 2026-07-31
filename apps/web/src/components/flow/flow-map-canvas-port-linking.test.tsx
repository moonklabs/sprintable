// @vitest-environment jsdom
//
// story #2353 — 포트로 사람이 「없던 연결을 새로 만드는」 전체 왕복을 값으로 닫는다. doc
// `flow-port-slot-spec`의 판정선 그대로: ①끌어서-놓고-답한-뒤-되읽는 문장이 뜨는가
// ②되돌리는 길이 남는가 ③사람이 만든 선이 실선인가 ④키보드로도 이을 수 있는가 ⑤실패했는데
// 선이 서 있지 않은가. base-ui Dialog는 document.body에 포탈되므로(#2354 교훈) container가
// 아니라 document에서 다이얼로그 내용을 찾는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowMapCanvas, type CreateLinkResult, type DeleteLinkResult } from './flow-map-canvas';
import type { FlowMapLane, FlowMapNode, FlowMapEdge } from './derive-flow-map';
import koMessages from '../../../messages/ko.json';

// story #2353 v1.1 정정 — 되돌리기 다이얼로그 제목이 declaredBy와 currentTeamMemberId(로그인
// 본인) 비교로 갈린다(resolveUndoTitle, flow-port-linking.ts). 기본은 'member-9'를 "나"로
// 둔다 — 대부분의 되돌리기 테스트가 declaredBy: 'member-9'로 "내가 만든" 케이스를 잰다.
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeNode(overrides: Partial<FlowMapNode> = {}): FlowMapNode {
  return { id: 'n1', storyNumber: 1, title: 'Story', status: 'backlog', kind: 'now', depth: 0, ...overrides };
}

function makeEdge(overrides: Partial<FlowMapEdge> = {}): FlowMapEdge {
  return { fromNodeId: 'n1', toNodeId: 'u1', kind: null, confirmed: true, ...overrides };
}

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [], edges: [],
    pastBundle: { total: 0, internalCount: 0, outgoingCount: 0 }, pastNodes: [],
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom은 elementFromPoint를 항상 null로 낸다 — 드래그 놓기/호버 판정이 이걸로 대상을
  // 찾으므로, 테스트별로 재정의한다(기본은 항상 null: "아무 데도 아님").
  document.elementFromPoint = vi.fn(() => null);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-9' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function dispatchPointer(el: Element | Document | Window, type: string, opts: { clientX?: number; clientY?: number } = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(ev, { clientX: opts.clientX ?? 0, clientY: opts.clientY ?? 0, pointerId: 1 });
  el.dispatchEvent(ev);
}

async function renderCanvas(lane: FlowMapLane, overrides: { onCreateLink?: (p: { apiSourceId: string; targetId: string; relationKind: string | null }) => Promise<CreateLinkResult>; onDeleteLink?: (id: string, anchor: string) => Promise<DeleteLinkResult>; selectedNodeId?: string | null } = {}) {
  const onCreateLink = overrides.onCreateLink ?? (async () => ({ ok: true }) as CreateLinkResult);
  const onDeleteLink = overrides.onDeleteLink ?? (async () => ({ ok: true }) as DeleteLinkResult);
  await act(async () => {
    root.render(wrap(
      <FlowMapCanvas
        lanes={[lane]}
        onSelectStory={() => {}}
        onTogglePastBundle={() => {}}
        loadingPastBundleEpicIds={new Set()}
        onCreateLink={onCreateLink}
        onDeleteLink={onDeleteLink}
        memberMap={{ 'member-9': { name: '미르코' }, 'member-OTHER': { name: '디디' } }}
        selectedNodeId={overrides.selectedNodeId ?? null}
      />,
    ));
  });
  return { onCreateLink, onDeleteLink };
}

function getPort(nodeId: string): HTMLButtonElement {
  const wrapper = container.querySelector(`[data-node-id="${nodeId}"]`);
  const port = wrapper?.querySelectorAll('button')[1]; // [0]=카드 열기, [1]=포트
  expect(port).toBeTruthy();
  return port as HTMLButtonElement;
}

describe('FlowMapCanvas — port button (AC1·AC2, 상시 가시성)', () => {
  it('renders one port per node card, on the wrapper with data-node-id (호버 없이도 항상 존재한다)', async () => {
    const lane = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await renderCanvas(lane);
    const port = getPort('n1');
    expect(port.getAttribute('aria-label')).toContain('1');
  });

  it('a node card has exactly 2 buttons — the select button and the port (no nested buttons, valid HTML)', async () => {
    const lane = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await renderCanvas(lane);
    const wrapper = container.querySelector('[data-node-id="n1"]')!;
    expect(wrapper.querySelectorAll('button')).toHaveLength(2);
  });
});

describe('FlowMapCanvas — 포인터 드래그 (AC3·AC4)', () => {
  it('pointerdown on a port then pointerup over a valid target opens the confirm dialog with the direction-echo sentence', async () => {
    const nowNode = makeNode({ id: 'n1', storyNumber: 101, kind: 'now' });
    const queueNode = makeNode({ id: 'u1', storyNumber: 102, kind: 'queue', depth: 0 });
    const lane = makeLane({ nowNodes: [nowNode], queueNodesByDepth: new Map([[0, [queueNode]]]) });
    await renderCanvas(lane);

    const port = getPort('n1');
    const targetWrapper = container.querySelector('[data-node-id="u1"]')!;
    document.elementFromPoint = vi.fn(() => targetWrapper);

    await act(async () => { dispatchPointer(port, 'pointerdown', { clientX: 10, clientY: 10 }); });
    await act(async () => { dispatchPointer(window, 'pointerup', { clientX: 200, clientY: 10 }); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toContain('101');
    expect(dialogTitle?.textContent).toContain('102');
  });

  it('pointerup over nothing valid (no elementFromPoint hit) cancels back to idle — no dialog', async () => {
    const lane = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await renderCanvas(lane);
    const port = getPort('n1');

    await act(async () => { dispatchPointer(port, 'pointerdown'); });
    await act(async () => { dispatchPointer(window, 'pointerup', { clientX: 999, clientY: 999 }); });

    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
  });

  it('dims a node that is not a valid drop target (self) while dragging (AC3)', async () => {
    const lane = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await renderCanvas(lane);
    const port = getPort('n1');

    await act(async () => { dispatchPointer(port, 'pointerdown'); });
    await act(async () => { dispatchPointer(window, 'pointermove', { clientX: 5, clientY: 5 }); });

    const selectButton = container.querySelector('[data-node-id="n1"] button')!;
    expect(selectButton.className).toContain('opacity-50');
  });

  it('does NOT dim a valid drop target while dragging', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
    });
    await renderCanvas(lane);
    const port = getPort('n1');
    await act(async () => { dispatchPointer(port, 'pointerdown'); });

    const targetSelectButton = container.querySelector('[data-node-id="u1"] button')!;
    expect(targetSelectButton.className).not.toContain('opacity-50');
  });

  it('dims a node that already has an edge to the drag source (AC16 — one relationship per pair, no re-linking)', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1' })],
    });
    await renderCanvas(lane);
    const port = getPort('n1');
    await act(async () => { dispatchPointer(port, 'pointerdown'); });

    const targetSelectButton = container.querySelector('[data-node-id="u1"] button')!;
    expect(targetSelectButton.className).toContain('opacity-50');
  });

  // 유나 가디언 리뷰(2026-07-31, PR#2725 issuecomment-5139662978, 라이브 실측) — selected
  // ring은 「패널이 열림」이 아니라 「URL에 ?story=가 있음」이라, 패널을 닫아도(#2354 AC6)
  // 남는다. 그 상태에서 다른 포트로부터 «그 노드»를 향해 끌면, 무관한 selected ring이
  // isDropHover ring과 겹쳐 "여기가 놓을 자리"로 오인된다. 재현: A(selectedNodeId)가 이미
  // 선택된 채, B 포트에서 드래그를 시작하는 것만으로 A의 selected ring이 꺼져야 한다
  // (isDropHover 판정과 무관하게 — 드래그 시작 자체가 트리거).
  it('turns OFF the selected ring on ANY node the moment linking starts (AC6\'s "stays selected after close" must not masquerade as a drop target)', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
    });
    await renderCanvas(lane, { selectedNodeId: 'a' });

    const selectButtonA = container.querySelector('[data-node-id="a"] button')!;
    expect(selectButtonA.className).toContain('ring-2'); // idle 상태 — selected ring이 보인다.

    const portB = getPort('b');
    await act(async () => { dispatchPointer(portB, 'pointerdown'); });

    // 잇기가 시작된 순간 A의 selected ring은 꺼져야 한다 — A가 실제로 유효한 드롭 대상이라
    // isDropHover로 다시 켜질 수 있지만, 그건 호버(마우스가 실제로 A 위에 있음)가 결정할
    // 일이지 selected 하나만으로 "놓을 자리"처럼 보이면 안 된다. 여기선 호버가 없으므로
    // (elementFromPoint가 기본 null) A에 어떤 ring도 없어야 한다.
    expect(selectButtonA.className).not.toContain('ring-2');
  });
});

describe('FlowMapCanvas — 확認 다이얼로그 (AC5·AC6·AC16)', () => {
  async function openConfirmDialog() {
    const nowNode = makeNode({ id: 'n1', storyNumber: 1, kind: 'now' });
    const queueNode = makeNode({ id: 'u1', storyNumber: 2, kind: 'queue', depth: 0 });
    const lane = makeLane({ nowNodes: [nowNode], queueNodesByDepth: new Map([[0, [queueNode]]]) });
    const createLink = vi.fn(async () => ({ ok: true }) as CreateLinkResult);
    await renderCanvas(lane, { onCreateLink: createLink });

    const port = getPort('n1');
    const targetWrapper = container.querySelector('[data-node-id="u1"]')!;
    document.elementFromPoint = vi.fn(() => targetWrapper);
    await act(async () => { dispatchPointer(port, 'pointerdown'); });
    await act(async () => { dispatchPointer(window, 'pointerup', { clientX: 200 }); });
    return { createLink };
  }

  it('shows 3 kind buttons + "종류는 나중에" + 취소 (AC5) — no "관계가 아닙니다" option (that belongs to the confirm-candidate flow, not this one)', async () => {
    await openConfirmDialog();
    const buttons = Array.from(document.body.querySelectorAll('[data-slot="dialog-content"] button')).map((b) => b.textContent);
    expect(buttons).toContain('여기서 나온 일');
    expect(buttons).toContain('다음에 할 일');
    expect(buttons).toContain('대신하는 일');
    expect(buttons).toContain('종류는 나중에 정하겠습니다');
    expect(buttons).toContain('취소');
    expect(buttons.some((t) => t?.includes('관계가 아닙니다'))).toBe(false);
  });

  it('picking "여기서 나온 일"(spawned) calls onCreateLink with the drag direction as-is', async () => {
    const { createLink } = await openConfirmDialog();
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '여기서 나온 일')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(createLink).toHaveBeenCalledWith({ apiSourceId: 'n1', targetId: 'u1', relationKind: 'spawned' });
  });

  it('picking "다음에 할 일"(followed) calls onCreateLink with the API direction FLIPPED (so the rendered arrow still points drag-start→drag-end)', async () => {
    const { createLink } = await openConfirmDialog();
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '다음에 할 일')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(createLink).toHaveBeenCalledWith({ apiSourceId: 'u1', targetId: 'n1', relationKind: 'followed' });
  });

  it('picking "종류는 나중에"(AC6) calls onCreateLink with relationKind=null (declare-only, matches the BE contract split)', async () => {
    const { createLink } = await openConfirmDialog();
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '종류는 나중에 정하겠습니다')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(createLink).toHaveBeenCalledWith({ apiSourceId: 'n1', targetId: 'u1', relationKind: null });
  });

  it('picking 취소 closes the dialog without calling onCreateLink', async () => {
    const { createLink } = await openConfirmDialog();
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '취소')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(createLink).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
  });
});

describe('FlowMapCanvas — 실패 처리 (AC14·AC15, 낙관적 업데이트 금지)', () => {
  it('on failure, shows the server-provided error text verbatim in a persistent banner (not a toast)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const queueNode = makeNode({ id: 'u1', kind: 'queue', depth: 0 });
    const lane = makeLane({ nowNodes: [nowNode], queueNodesByDepth: new Map([[0, [queueNode]]]) });
    const createLink = vi.fn(async () => ({ ok: false, error: 'Cannot link a story to itself' }) as CreateLinkResult);
    await renderCanvas(lane, { onCreateLink: createLink });

    const port = getPort('n1');
    const targetWrapper = container.querySelector('[data-node-id="u1"]')!;
    document.elementFromPoint = vi.fn(() => targetWrapper);
    await act(async () => { dispatchPointer(port, 'pointerdown'); });
    await act(async () => { dispatchPointer(window, 'pointerup'); });
    const spawnBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '여기서 나온 일')!;
    await act(async () => { spawnBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain('Cannot link a story to itself');
    // 확認 다이얼로그는 닫혔다(더 이상 점선을 확定/취소 둘 다 아닌 채로 붙들지 않는다).
    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
  });

  it('on success, the confirm dialog closes and no error banner appears', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const queueNode = makeNode({ id: 'u1', kind: 'queue', depth: 0 });
    const lane = makeLane({ nowNodes: [nowNode], queueNodesByDepth: new Map([[0, [queueNode]]]) });
    await renderCanvas(lane);

    const port = getPort('n1');
    const targetWrapper = container.querySelector('[data-node-id="u1"]')!;
    document.elementFromPoint = vi.fn(() => targetWrapper);
    await act(async () => { dispatchPointer(port, 'pointerdown'); });
    await act(async () => { dispatchPointer(window, 'pointerup'); });
    const spawnBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '여기서 나온 일')!;
    await act(async () => { spawnBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('FlowMapCanvas — 키보드 동등 경로 (AC13)', () => {
  it('Enter on the port starts linking, ArrowRight moves to the next valid target, Enter drops → opens the confirm dialog', async () => {
    const nowNode = makeNode({ id: 'n1', storyNumber: 1, kind: 'now' });
    const q0 = makeNode({ id: 'u1', storyNumber: 2, kind: 'queue', depth: 0 });
    const lane = makeLane({ nowNodes: [nowNode], queueNodesByDepth: new Map([[0, [q0]]]) });
    await renderCanvas(lane);
    const port = getPort('n1');

    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toContain('1');
    expect(dialogTitle?.textContent).toContain('2');
  });

  it('Escape cancels the keyboard linking session — no dialog opens on a later Enter without re-starting', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
    });
    await renderCanvas(lane);
    const port = getPort('n1');

    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
  });

  it('ArrowRight only cycles through VALID targets — an already-linked node is skipped (AC16)', async () => {
    const nowNode = makeNode({ id: 'n1', storyNumber: 1, kind: 'now' });
    const linked = makeNode({ id: 'u1', storyNumber: 2, kind: 'queue', depth: 0 });
    const openTarget = makeNode({ id: 'u2', storyNumber: 3, kind: 'queue', depth: 0 });
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, [linked, openTarget]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1' })],
    });
    await renderCanvas(lane);
    const port = getPort('n1');

    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    // 첫 유효 대상이 이미 u2(u1은 이미 이어져 있어 순회에서 빠진다)여야 한다 — Enter로 바로 닫자.
    await act(async () => { port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toContain('3'); // u2의 storyNumber
    expect(dialogTitle?.textContent).not.toContain('나옴 #2'); // 방어적 — u1이 아님을 텍스트로도 재확認
  });
});

describe('FlowMapCanvas — 되돌리기 (AC7·AC8, 그 선 자체가 진입점)', () => {
  it('clicking a declared single-candidate line opens the undo dialog with "내가 만듦" signature', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({
        fromNodeId: 'n1', toNodeId: 'u1', confirmed: true,
        candidateId: 'cand-1', declaredBy: 'member-9', declaredAt: '2026-07-31T12:00:00Z',
      })],
    });
    await renderCanvas(lane);
    const line = container.querySelector('line[data-edge-candidate-id="cand-1"]')!;
    await act(async () => { line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toBe('내가 만든 연결입니다');
  });

  // 유나 가디언 리뷰(2026-07-31, issuecomment-5139439284) — 「내가 만듦」이 조건 없이 떴다
  // (남이 만든 선도 「내가 만든」으로 읽혀 파괴적 조작인 [지우기] 바로 앞에 오인이 섰다).
  // doc v1.1 ㉣ 정정 — declaredBy로 갈라 「{이름}이 만든 연결입니다」를 보여야 한다.
  it('shows "{name}이 만든 연결입니다" when declaredBy is a DIFFERENT member than the logged-in user', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({
        fromNodeId: 'n1', toNodeId: 'u1', confirmed: true,
        candidateId: 'cand-2', declaredBy: 'member-OTHER', declaredAt: '2026-07-31T12:00:00Z',
      })],
    });
    await renderCanvas(lane);
    const line = container.querySelector('line[data-edge-candidate-id="cand-2"]')!;
    await act(async () => { line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toBe('디디이 만든 연결입니다');
  });

  // doc v1.1 ㉣ — 모르는 채 「내가」로 단정하지 않는다(declaredBy가 없거나, memberMap에
  // 이름이 없으면 중립).
  it('falls back to the neutral "사람이 만든 연결입니다" when the author is unknown (declaredBy present but not in memberMap)', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({
        fromNodeId: 'n1', toNodeId: 'u1', confirmed: true,
        candidateId: 'cand-3', declaredBy: 'member-UNKNOWN-TO-MAP', declaredAt: '2026-07-31T12:00:00Z',
      })],
    });
    await renderCanvas(lane);
    const line = container.querySelector('line[data-edge-candidate-id="cand-3"]')!;
    await act(async () => { line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dialogTitle = document.body.querySelector('[data-slot="dialog-title"]');
    expect(dialogTitle?.textContent).toBe('사람이 만든 연결입니다');
  });

  it('does NOT make a group with count>1 (bundled) clickable — no data-edge-candidate-id, no hit-area', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      pastTotal: 5,
      pastBundle: { total: 5, internalCount: 0, outgoingCount: 2 },
      edges: [
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', candidateId: 'a' }),
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', candidateId: 'b' }),
      ],
    });
    await renderCanvas(lane);
    const line = container.querySelector('line[data-edge-kind]')!;
    expect(line.getAttribute('data-edge-candidate-id')).toBeFalsy();
  });

  // 오르테가 PO 지적(2026-07-31) — 과거 묶음 카드로 접힌 쪽에 닿은 «단일» 간선(count===1)은
  // deriveFlowMapLane의 분류상 항상 반대편이 실재 story id다(양끝 다 과거인 경우는
  // internalCount로 빠져 애초에 렌더 안 됨) — 그런 간선도 되돌리기가 되어야 한다. 이걸
  // 안 하면 "클릭했는데 아무 반응 없음"이 «고장난 것»처럼 보인다.
  it('a SINGLE candidate edge touching the past-bundle placeholder is still undoable, using the real (non-bundle) side as the DELETE anchor', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      pastTotal: 3,
      pastBundle: { total: 3, internalCount: 0, outgoingCount: 1 },
      edges: [makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', confirmed: true, candidateId: 'cand-bundle', declaredBy: 'member-9' })],
    });
    const deleteLink = vi.fn(async () => ({ ok: true }) as DeleteLinkResult);
    await renderCanvas(lane, { onDeleteLink: deleteLink });

    const line = container.querySelector('line[data-edge-candidate-id="cand-bundle"]');
    expect(line).not.toBeNull();
    await act(async () => { line!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('내가 만든 연결입니다');

    const deleteBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '지우기')!;
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // fromNodeId는 '__past-bundle__'이라 앵커로 못 쓴다 — 실재하는 toNodeId('n1')를 써야 한다.
    expect(deleteLink).toHaveBeenCalledWith('cand-bundle', 'n1');
  });

  it('clicking [지우기] calls onDeleteLink with the candidateId and an anchor story id, then closes on success', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1', confirmed: true, candidateId: 'cand-1', declaredAt: '2026-07-31T12:00:00Z' })],
    });
    const deleteLink = vi.fn(async () => ({ ok: true }) as DeleteLinkResult);
    await renderCanvas(lane, { onDeleteLink: deleteLink });

    const line = container.querySelector('line[data-edge-candidate-id="cand-1"]')!;
    await act(async () => { line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const deleteBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '지우기')!;
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(deleteLink).toHaveBeenCalledWith('cand-1', 'n1');
    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
  });

  it('on delete failure, shows the server error and keeps the dialog open (does not silently lose the line)', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1', confirmed: true, candidateId: 'cand-1' })],
    });
    const deleteLink = vi.fn(async () => ({ ok: false, error: 'Only a declared reference can be removed this way' }) as DeleteLinkResult);
    await renderCanvas(lane, { onDeleteLink: deleteLink });

    const line = container.querySelector('line[data-edge-candidate-id="cand-1"]')!;
    await act(async () => { line.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const deleteBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '지우기')!;
    await act(async () => { deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(document.body.textContent).toContain('Only a declared reference can be removed this way');
    expect(document.body.querySelector('[data-slot="dialog-title"]')).not.toBeNull();
  });
});

describe('FlowMapCanvas — 슬롯 문구 전환 (AC9, doc ㉤)', () => {
  it('shows "여기에 놓으면 다음이 됩니다" while linking, and the normal "아직 없습니다" text otherwise', async () => {
    // shouldShowNoDeeperReason은 depth 0 큐가 있고 depth 1 이상이 없을 때만 참이다 —
    // now 노드 하나뿐인 레인은 조건 자체가 안 걸리므로 depth 0 큐 노드를 하나 둔다.
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue', depth: 0 })]]]),
    });
    await renderCanvas(lane);
    expect(container.textContent).toContain('깊이 1 이후가 없습니다');
    expect(container.textContent).not.toContain('여기에 놓으면 다음이 됩니다');

    const port = getPort('n1');
    await act(async () => { dispatchPointer(port, 'pointerdown'); });

    expect(container.textContent).toContain('여기에 놓으면 다음이 됩니다');
    expect(container.textContent).not.toContain('깊이 1 이후가 없습니다');
  });
});
