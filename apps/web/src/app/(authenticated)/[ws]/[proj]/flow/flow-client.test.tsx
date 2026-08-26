// @vitest-environment jsdom
//
// story #2354 회귀 가드 — 「노드를 눌러도 지도가 살아 있게」의 근본(옛 handleSelectStory가
// `view=list`를 함께 갈아 끼워 캔버스를 언마운트시켰다)이 다시 안 나는지 값으로 닫는다.
// KanbanBoard/NextMakerScreen/FlowNodeStoryPanel은 각자 자기 테스트가 있으므로 여기선 얇은
// 스텁으로 대체하고, flow-client.tsx 자신의 배선(URL 조립·panelOpen 로컬 상태·view별
// 렌더 분기)만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

let currentSearch = '';
// push는 실제 next/navigation처럼 "URL이 바뀐다"까지 흉내낸다(그래야 뒤이은
// setPanelOpen(true)로 인한 리렌더에서 useSearchParams()가 새 값을 본다) — 실제 앱에서는
// router.push 자체가 이 반영을 일으킨다, 이 목이 그 효과만 대신한다.
const pushMock = vi.fn((url: string) => {
  const qIndex = url.indexOf('?');
  currentSearch = qIndex >= 0 ? url.slice(qIndex + 1) : '';
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
}));

// story #2930 I3 — WorkspaceFrameTabs는 useParams(next/navigation, 이 스위트가 mock 안 함)를
// 쓴다. flow-client 자체의 로직과 무관한 크롬이라 TopBarSlot과 동형으로 스텁한다.
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({
  WorkspaceFrameTabs: () => null,
}));

vi.mock('@/components/kanban/kanban-board', () => ({
  KanbanBoard: () => <div data-testid="kanban-board-stub">kanban</div>,
}));

// story #2531 — 지구층은 default view가 됐으니 view=flow/list 를 테스트하는 기존 스펙들이
// 실제 fetch를 안 타게 얇은 스텁으로 대체한다(지구층 자체 스펙은 별도 테스트 파일).
vi.mock('@/components/flow/hypothesis-earth-layer', () => ({
  HypothesisEarthLayer: ({ onSelectHypothesis }: { onSelectHypothesis: (id: string) => void }) => (
    <div data-testid="hypothesis-earth-layer-stub">
      earth
      <button type="button" onClick={() => onSelectHypothesis('hyp-abc')}>select-hypothesis</button>
    </div>
  ),
}));

// story #2533 — 서사 패널 스텁(자기 fetch를 exercise 안 함, hypothesisId threading만 검증).
vi.mock('@/components/flow/hypothesis-narrative-panel', () => ({
  HypothesisNarrativePanel: ({ hypothesisId, onClose, onNavigateToGoal }: { hypothesisId: string; onClose: () => void; onNavigateToGoal?: (goalId: string) => void }) => (
    <div data-testid="hypothesis-narrative-panel-stub">
      <span data-testid="narrative-hypothesis-id">{hypothesisId}</span>
      <button type="button" onClick={onClose}>close-narrative</button>
      <button type="button" onClick={() => onNavigateToGoal?.('goal-xyz')}>navigate-to-goal</button>
    </div>
  ),
}));

// 유나 가디언 리뷰(2026-07-31, PR#2744 issuecomment) 회귀 가드 재료 — 옛 스텁은 items를
// 안 받아 렌더했다("양성대조가 될 수 없는 표본"). 실제 kindLabel까지 텍스트로 노출해야
// "항목이 «있는» 상태"에서 라벨 충돌을 값으로 잡을 수 있다.
vi.mock('@/components/glance/exception-stream', () => ({
  ExceptionStream: ({ items = [] }: { items?: { id: string; kindLabel: string; claim: string }[] }) => (
    <div data-testid="exception-stream-stub">
      {items.map((it) => (
        <div key={it.id} data-testid="exception-item">
          <span data-testid="exception-item-kind">{it.kindLabel}</span>
          <span data-testid="exception-item-claim">{it.claim}</span>
        </div>
      ))}
    </div>
  ),
}));

// vi.hoisted — loadGlanceData의 반환값을 테스트별로 오버라이드하기 위한 가변 mock. 기본은
// attentionSignals: []다(대부분 테스트가 서랍 내용에 무관) — "항목이 있는" 케이스만 특정
// 테스트에서 mockResolvedValueOnce로 덮어쓴다.
const { loadGlanceDataMock } = vi.hoisted(() => ({
  loadGlanceDataMock: vi.fn(async () => ({ memberMap: {}, attentionSignals: [] as unknown[] })),
}));
vi.mock('@/components/glance/load-glance-data', () => ({
  loadGlanceData: loadGlanceDataMock,
}));

// story #2531 — 카디르 ①HIGH 회귀가드 재료(모바일 기본값 분기 테스트)가 isMobile을 true로
// 뒤집을 수 있어야 해서 mutable로 바꾼다. 기본은 false(기존 스펙 전부 그대로 통과).
let isMobileMock = false;
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock,
}));

// NextMakerScreen 스텁 — onSelectStory 호출 버튼 + selectedNodeId를 텍스트로 노출(threading 검증용).
vi.mock('@/components/flow/next-maker-screen', () => ({
  NextMakerScreen: ({ onSelectStory, selectedNodeId, focusGoalId }: { onSelectStory: (id: string) => void; selectedNodeId?: string | null; focusGoalId?: string | null }) => (
    <div data-testid="next-maker-screen-stub">
      <span data-testid="selected-node-id">{selectedNodeId ?? 'none'}</span>
      <span data-testid="focus-goal-id">{focusGoalId ?? 'none'}</span>
      <button type="button" onClick={() => onSelectStory('story-abc')}>select-node</button>
    </div>
  ),
}));

// FlowNodeStoryPanel 스텁 — storyId를 텍스트로 노출 + close 버튼.
vi.mock('@/components/flow/flow-node-story-panel', () => ({
  FlowNodeStoryPanel: ({ storyId, onClose }: { storyId: string; onClose: () => void }) => (
    <div data-testid="flow-node-story-panel-stub">
      <span data-testid="panel-story-id">{storyId}</span>
      <button type="button" onClick={onClose}>close-panel</button>
    </div>
  ),
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

beforeEach(() => {
  currentSearch = '';
  isMobileMock = false;
  pushMock.mockClear();
  loadGlanceDataMock.mockClear();
  loadGlanceDataMock.mockResolvedValue({ memberMap: {}, attentionSignals: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderFlowClient() {
  const { default: FlowPageClient } = await import('./flow-client');
  await act(async () => {
    root.render(wrap(<FlowPageClient projectId="p1" wsSlug="ws-1" projSlug="proj-1" />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('FlowPageClient — story #2354 (노드 클릭이 지도를 안 끈다)', () => {
  it('handleSelectStory pushes ?story=<id> WITHOUT touching view — 옛 버그(view=list 강제)가 재발하지 않는다', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'select-node');
    expect(selectButton).toBeTruthy();
    await act(async () => {
      selectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('story=story-abc');
    // 이게 이 회귀가드의 핵심 — 옛 코드는 여기서 반드시 view=list를 같이 붙였다.
    // story #2531 이후 view=flow는 (테스트가 이미 그 탭에 있었으므로) 유지되는 게 맞다 —
    // 지켜야 하는 것은 "list로 강제 전환되지 않는다"는 것 하나.
    expect(pushedUrl).not.toContain('view=list');
  });

  it('clicking a node opens the overlay panel while the flow canvas stub stays mounted (캔버스가 언마운트되지 않는다)', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'select-node');
    await act(async () => {
      selectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 캔버스 스텁은 그대로 살아있다 — 클릭이 언마운트를 일으키지 않는다.
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-story-id"]')?.textContent).toBe('story-abc');
  });

  it('deep link (?story=<id> already in URL) opens the panel on mount without needing a click', async () => {
    currentSearch = 'view=flow&story=story-deep';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-story-id"]')?.textContent).toBe('story-deep');
    // selectedNodeId도 같은 값으로 NextMakerScreen에 threading됨 — 노드 고리 강조의 재료.
    expect(container.querySelector('[data-testid="selected-node-id"]')?.textContent).toBe('story-deep');
  });

  it('closing the panel keeps the node selected (AC6 판정선) — selectedNodeId survives close, only panel visibility toggles', async () => {
    currentSearch = 'view=flow&story=story-abc';
    await renderFlowClient();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).not.toBeNull();

    const closeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'close-panel');
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 패널은 사라지지만 — URL의 story는 안 지웠으므로(닫기가 router 호출을 안 함) selectedNodeId는 그대로다.
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="selected-node-id"]')?.textContent).toBe('story-abc');
  });

  it('view=list renders KanbanBoard and does NOT also mount the flow overlay panel (AC9 — no double panel)', async () => {
    currentSearch = 'view=list&story=story-abc';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="kanban-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).toBeNull();
    // KanbanBoard 스스로 story=를 읽어 자기 방식으로 여는 것이 기존 동작 — 여기서 또 열면 두 벌.
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();
  });
});

// PO 정정(2026-07-31) — story #2352의 원래 결함은 관제 서랍의 "게이트·막힘 신호 · N"
// 라벨이 0단계 카드의 "승인 대기 · 28"과 다른 표를 세면서 같은 낱말("막힘")로 화면이
// 자기모순한 것이었다. 지시는 «그 수»를 이름 없이 빼는 것이었는데, 처음 구현은 서랍
// 영역(ExceptionStream) 자체를 통째로 걷어내 목적어가 넓어졌다 — #2224 AC4가 이 컴포넌트를
// 하단 관제와 "하나"로 요구하는 것과도 어긋났다. 서랍은 남고, 라벨만 숫자 없이 갈린다.
describe('FlowPageClient — story #2352 정정(PO, 2026-07-31) — 관제 서랍은 남긴다, 라벨만 간다', () => {
  it('renders the ExceptionStream drawer (region survives) with a label that has NO count number and does not say "막힘"', async () => {
    await renderFlowClient();

    expect(container.querySelector('[data-testid="exception-stream-stub"]')).not.toBeNull();
    const summary = Array.from(container.querySelectorAll('summary')).find(
      (s) => container.contains(s),
    );
    expect(summary).toBeTruthy();
    expect(summary!.textContent).not.toContain('막힘');
    // "게이트·막힘 신호 · 0" 처럼 숫자를 붙이던 옛 라벨 자리 — 새 라벨은 그 어떤 아라비아
    // 숫자도 달지 않는다(그 수 자체가 원래 결함이었다).
    expect(summary!.textContent).not.toMatch(/\d/);
  });
});

// 유나 가디언 리뷰(2026-07-31, PR#2744) — "지금 통과처럼 보이는 이유가 «서랍이 비어서»"였다.
// attentionSignals=[]인 채로는 이 조건이 실패할 «수가 없어» 양성대조가 안 섰다(오늘 세 번째로
// 나온 그 클래스 — feedback_positive_control_must_be_able_to_fail). 항목이 «있는» 상태로
// 재구성해 실제 라벨 충돌을 값으로 잡는다.
//
// PO 실측 재정정(2026-07-31, 같은 판) — 첫 시도는 셋 중 둘이 «이름이 약속한 것을 안 쟀다»:
// merge_ready는 length>0(실패할 수 없는 자)이었고, blocked는 toContain 이 아니라 not.toBe라
// "다른 일에 막힘"이 실제로 「막힘」을 말하는데도 통과했다. 헤더가 쓰는 «실제» 문구 집합을
// ko.json에서 그대로 끌어와 「어느 헤더 문구도 이 kindLabel을 부분문자열로 갖지 않는다」로
// 셋을 한 자로 통일한다 — 손 타이핑 중복이 아니라 실 i18n 값에 기대므로 헤더 문구가 바뀌면
// 이 가드도 같이 움직인다.
describe('FlowPageClient — story #2365 후속(유나·PO, 2026-07-31) — 서랍 «항목»의 kindLabel도 헤딩 카드와 안 겹친다', () => {
  // next-maker-header.tsx가 실제로 렌더하는 문구 전부(라벨+본문) — 이 중 어느 것도 서랍
  // kindLabel을 부분문자열로 포함하면 주어 없이 겹쳐 읽힌다.
  const headerPhrases = [
    koMessages.flow.nextMakerCanDo,
    koMessages.flow.nextMakerUnowned,
    koMessages.flow.nextMakerPendingApproval,
  ];

  function expectNoCollisionWithHeader(kindText: string) {
    for (const phrase of headerPhrases) {
      expect(phrase).not.toContain(kindText);
    }
  }

  it('a gate_pending item\'s kindLabel does not collide with any header phrase', async () => {
    loadGlanceDataMock.mockResolvedValue({
      memberMap: {},
      attentionSignals: [
        { kind: 'gate_pending', story_id: null, title: '결재 대기 중인 항목', ref: { approval_id: 'a1' } },
      ],
    });
    await renderFlowClient();

    const item = container.querySelector('[data-testid="exception-item"]');
    expect(item).not.toBeNull();
    const kindText = container.querySelector('[data-testid="exception-item-kind"]')?.textContent ?? '';
    expect(kindText).toBe(koMessages.glance.exceptionKindGatePending);
    expectNoCollisionWithHeader(kindText);
  });

  it('a blocked item\'s kindLabel does not collide with any header phrase, AND actually states what is blocking it (실제로 잰다, 이름만 적지 않는다)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      memberMap: {},
      attentionSignals: [
        { kind: 'blocked', story_id: 's1', title: '막혀 있는 스토리', ref: {} },
      ],
    });
    await renderFlowClient();

    const kindText = container.querySelector('[data-testid="exception-item-kind"]')?.textContent ?? '';
    expectNoCollisionWithHeader(kindText);
    // #2352가 금지한 것은 「막힘」 «단독형»이다 — "다른 일에 막힘"처럼 무엇에 막혔는지 말과
    // 함께면 자기모순이 아니다. 이 assertion이 그 "무엇"이 실제로 있는지를 값으로 잰다.
    expect(kindText).toContain('다른 일');
  });

  it('a merge_ready item\'s kindLabel does not collide with any header phrase (헤더에 「머지」 문구가 «생기는 날» 이 자가 잡아낸다)', async () => {
    loadGlanceDataMock.mockResolvedValue({
      memberMap: {},
      attentionSignals: [
        { kind: 'merge_ready', story_id: 's2', title: '머지 준비된 스토리', ref: {} },
      ],
    });
    await renderFlowClient();

    const kindText = container.querySelector('[data-testid="exception-item-kind"]')?.textContent ?? '';
    expectNoCollisionWithHeader(kindText);
  });
});

// story #2531(E-FLOW-V4 S1, PO 게이트 2026-08-08 재정의) — 당시엔 「본체가 지도로
// 서는가」를 «가설이 기본 랜딩(?view= 없음)으로 최상위를 차지하는가»로 판정해 데스크톱
// 기본값을 hypothesis로 세웠다. ⛔story #3101(Board IA 1단계 B, PO 확定 2026-08-26)이
// 그 판정을 다시 뒤집었다 — 탭 이름이 이미 "보드"인데 첫 착지가 가설 화면이면 명명과
// 렌더가 어긋난다(§3043이 모바일에서 겪은 것과 같은 클래스, 이번엔 데스크톱) — 그래서
// 데스크톱도 모바일처럼 list(칸반)가 기본이 됐다. 이 describe 이름·아래 첫 테스트는
// #2531 당시의 값을 남겨두되(역사 기록), 실제 값은 #3101 기준으로 갱신한다.
describe('FlowPageClient — story #2531→#3101 기본 랜딩 변천(현재=list/칸반)', () => {
  it('?view= 없이 진입하면 기본으로 목록(KanbanBoard)이 렌더된다 — 가설·갈래가 아니다(#3101)', async () => {
    await renderFlowClient();

    expect(container.querySelector('[data-testid="kanban-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).toBeNull();
  });

  it('세그에 가설·갈래·목록 3탭이 모두 뜬다', async () => {
    await renderFlowClient();

    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain(koMessages.flow.viewHypothesis);
    expect(buttons).toContain(koMessages.flow.viewFlow);
    expect(buttons).toContain(koMessages.flow.viewList);
  });

  it('갈래 탭(?view=flow)을 누르면 URL이 view=flow로 바뀐다', async () => {
    await renderFlowClient();

    const flowTabButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.flow.viewFlow,
    );
    expect(flowTabButton).toBeTruthy();
    await act(async () => {
      flowTabButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('view=flow');
  });

  // story #3101 — 기본값이 list로 옮겨가며 "URL을 깨끗이 지워도 되는" 자격도 hypothesis에서
  // list로 옮겨갔다(setView 주석 참고). 가설 탭을 누르면 이제 view=hypothesis를 명시로
  // 남겨야 한다 — 예전처럼 지우면 parseView가 빈 URL을 list로 되돌려 읽어 가설 화면이
  // 증발한다(G1 위반).
  it('가설 탭을 누르면 URL에 view=hypothesis가 명시로 남는다(#3101, 기본값이 list로 바뀌어 지우면 안 됨)', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();

    const hypothesisTabButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.flow.viewHypothesis,
    );
    await act(async () => {
      hypothesisTabButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('view=hypothesis');
  });

  it('목록 탭으로 돌아가면(setView("list")) URL에서 view= 쿼리를 지운다(#3101, 기본값=파라미터 없음=list)', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();

    const listTabButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === koMessages.flow.viewList,
    );
    await act(async () => {
      listTabButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).not.toContain('view=');
  });
});

// 카디르 라이브 QA(2026-08-09, S1) — REQUEST_CHANGES 2건 회귀가드.
// story #3043(PO+유나 IA 확定 ⓑ, 2026-08-25) — 모바일 기본값이 다시 갈렸다. 예전엔
// #2225(모바일 3화면 대체 세그)가 곧 착지할 것을 전제로 flow(NextMakerScreen)를 기본값
// 삼았으나, #2225는 실제로 한 줄도 안 짜인 채 status=backlog로 남아있었다(그라운딩 확認)
// — 세그 자체도 숨겨져 있었으니 모바일에서 갈래·목록(칸반) 둘 다 도달 UI 경로가 0인
// dead-end였다(PO가 "모바일에 보드 없다"고 오답할 정도의 실사고). 이제 세그를 모바일에서도
// 그대로 그리고(아래 새 describe), 파라미터 없을 때의 기본값도 list(칸반)로 바꾼다 — 원
// 신고("보드가 안 보인다")에 가장 가까운 화면을 첫 진입 기본값으로 세운다.
describe('FlowPageClient — story #3043→#3101 기본값=list(칸반), 모바일·데스크톱 공용', () => {
  it('모바일(isMobile=true)·?view= 없음 이면 기본값이 list(KanbanBoard)다', async () => {
    isMobileMock = true;
    await renderFlowClient();

    expect(container.querySelector('[data-testid="kanban-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).toBeNull();
    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).toBeNull();
  });

  // story #3101(2026-08-26) — #2531 시절엔 이 케이스가 "가설이 기본값(회귀 없음)"이었으나,
  // 그 판정 자체가 뒤집혔다(탭 이름="보드"인데 첫 착지가 가설이면 명명과 렌더가 어긋남).
  // 이제 데스크톱도 모바일과 같은 기본값을 쓴다 — isMobile 분기가 parseView에서 아예
  // 사라졌다(parseView 시그니처에서 isMobile 파라미터 제거).
  it('데스크톱(isMobile=false)·?view= 없음 이면 이제 list(KanbanBoard)가 기본값이다(#3101)', async () => {
    isMobileMock = false;
    await renderFlowClient();

    expect(container.querySelector('[data-testid="kanban-board-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).toBeNull();
  });

  it('모바일이라도 세그(가설|갈래|칸반)가 그려진다(예전엔 isMobile이면 렌더 자체를 안 했다)', async () => {
    isMobileMock = true;
    await renderFlowClient();

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toContain(koMessages.flow.viewHypothesis);
    expect(labels).toContain(koMessages.flow.viewFlow);
    expect(labels).toContain(koMessages.flow.viewList);
  });

  it('모바일이라도 ?view=flow가 명시돼 있으면 그 값을 그대로 존중한다(주소로 갈래 진입 회귀 없음)', async () => {
    isMobileMock = true;
    currentSearch = 'view=flow';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
  });

  it('모바일이라도 ?view=hypothesis가 URL에 명시돼 있으면 그대로 존중한다(주소로는 진입 가능)', async () => {
    isMobileMock = true;
    currentSearch = 'view=hypothesis';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).not.toBeNull();
  });

  // 카디르 재QA 비차단②(2026-08-09, #2930) — 모바일 공유링크/새로고침이 ?hypothesis=만
  // 들고 오면(흔한 형태) 위 모바일 기본값(flow)이 이겨 서사 패널이 안 떴다.
  it('모바일이라도 ?hypothesis=<id>만 있고 ?view= 없으면 가설 뷰로 추론해 패널이 뜬다(공유링크/새로고침 fix)', async () => {
    isMobileMock = true;
    currentSearch = 'hypothesis=h-shared';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hypothesis-narrative-panel-stub"]')).not.toBeNull();
  });

  it('모바일·?hypothesis= 있어도 ?view=flow가 명시돼 있으면 그 값을 그대로 존중한다(회귀 없음)', async () => {
    isMobileMock = true;
    currentSearch = 'hypothesis=h-shared&view=flow';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="next-maker-screen-stub"]')).not.toBeNull();
  });
});

describe('FlowPageClient — 카디르 QA fix(2026-08-09) ②패널 경계(구 2값 FlowView 잔재)', () => {
  it('가설 뷰에서 ?story=<id>가 있어도 FlowNodeStoryPanel이 새지 않는다(가설 뷰엔 선택 UI 자체가 없다)', async () => {
    // story #3101 — 기본값이 list로 바뀌어(#2531 시절의 "기본=가설" 전제가 깨짐) 이 테스트가
    // 실제로 검증하려는 뷰(가설)를 명시로 고정한다 — 기본값에 기대면 안 됨.
    currentSearch = 'view=hypothesis&story=story-leak';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="hypothesis-earth-layer-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-node-story-panel-stub"]')).toBeNull();
  });
});

// story #2533(E-FLOW-V4 S3) — 가설 카드 클릭→수직 서사 패널.
describe('FlowPageClient — story #2533 가설 카드 클릭이 서사 패널을 연다', () => {
  it('가설 카드를 선택하면 ?hypothesis=<id>가 URL에 붙고 패널이 뜬다(기존 view는 안 건드림)', async () => {
    // story #3101 — 기본값이 list로 바뀌어 가설 뷰(HypothesisEarthLayer가 실제로 마운트되는
    // 상태)를 명시로 고정해야 한다.
    currentSearch = 'view=hypothesis';
    await renderFlowClient();
    expect(container.querySelector('[data-testid="hypothesis-narrative-panel-stub"]')).toBeNull();

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'select-hypothesis');
    expect(selectButton).toBeTruthy();
    await act(async () => {
      selectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('hypothesis=hyp-abc');
    // handleSelectHypothesis는 view를 안 건드린다 — 기존 view=hypothesis가 그대로 보존됨을
    // 확認(#3101 전엔 기본값=파라미터없음=hypothesis라 "view= 자체가 없음"으로 이 불변식을
    // 쟀으나, 이제 기본값이 list라 hypothesis 뷰 자체가 view=hypothesis 명시를 요구한다).
    expect(pushedUrl).toContain('view=hypothesis');
  });

  it('?hypothesis=<id>가 이미 URL에 있으면(딥링크) 마운트 즉시 패널이 열린다', async () => {
    currentSearch = 'hypothesis=hyp-deep';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="hypothesis-narrative-panel-stub"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="narrative-hypothesis-id"]')?.textContent).toBe('hyp-deep');
  });

  it('패널을 닫으면 URL에서 ?hypothesis= 파라미터가 지워진다', async () => {
    currentSearch = 'hypothesis=hyp-deep';
    await renderFlowClient();

    const closeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'close-narrative');
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).not.toContain('hypothesis=');
  });

  it('갈래(view=flow) 뷰에서는 ?hypothesis=<id>가 있어도 서사 패널이 안 뜬다(가설 뷰 전용)', async () => {
    currentSearch = 'view=flow&hypothesis=hyp-abc';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="hypothesis-narrative-panel-stub"]')).toBeNull();
  });
});

// story #2535(E-FLOW-V4 S5) — 지구→대륙→도시 드릴다운.
describe('FlowPageClient — story #2535 지구→대륙→도시 드릴다운', () => {
  it('?goal=<id>가 URL에 있으면 NextMakerScreen에 focusGoalId로 흘러간다', async () => {
    currentSearch = 'view=flow&goal=goal-123';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="focus-goal-id"]')?.textContent).toBe('goal-123');
  });

  it('?goal= 없으면 focusGoalId가 null(기존 동작 무회귀)', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();

    expect(container.querySelector('[data-testid="focus-goal-id"]')?.textContent).toBe('none');
  });

  it('가설 패널의 "목표로 이동"을 누르면 view=flow&goal=<id>로 이동하고 hypothesis 파라미터는 지운다', async () => {
    currentSearch = 'hypothesis=hyp-abc';
    await renderFlowClient();

    const navButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'navigate-to-goal');
    expect(navButton).toBeTruthy();
    await act(async () => {
      navButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pushedUrl = pushMock.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('view=flow');
    expect(pushedUrl).toContain('goal=goal-xyz');
    expect(pushedUrl).not.toContain('hypothesis=');
  });

  it('축척 브레드크럼은 가설 뷰에서는 flow-client 레벨에서 안 뜬다(HypothesisEarthLayer가 자기 안에서 이미 그림, 중복 방지)', async () => {
    // story #3101 — 기본값이 list로 바뀌어 가설 뷰를 명시로 고정해야 한다(기본값 의존 금지).
    currentSearch = 'view=hypothesis';
    await renderFlowClient();
    // HypothesisEarthLayer는 얇은 스텁이라 사다리를 자체적으로 안 그린다 — 그런데도 사다리
    // 특유 라벨(대륙/건물)이 뜨면 flow-client.tsx가 중복으로 그리고 있다는 뜻이다.
    expect(container.textContent).not.toContain(koMessages.flow.ladderName_continent);
    expect(container.textContent).not.toContain(koMessages.flow.ladderName_building);
  });

  // story #3111(Board IA·D0 선행 하드픽스, 유나 D0 그라운딩 발견) — activeLevel 매핑 전수를
  // "텍스트가 존재한다"(항상 참 — 5개 rung 이름은 활성 여부와 무관하게 전부 렌더된다)가
  // 아니라 실제 active 강조 클래스(scale-ladder.test.tsx와 동일 패턴)로 핀한다. 이전엔
  // view=list가 «건물»(작업)을 활성화했는데, 칸반(view=list)의 단위는 스토리이므로 오류였다.
  it('갈래(view=flow) 뷰에서는 축척 브레드크럼이 "도시"를 활성으로 보인다(가설·목표·거리·건물은 비활성)', async () => {
    currentSearch = 'view=flow';
    await renderFlowClient();

    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const cityRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_city));
    expect(cityRung?.className).toContain('bg-gradient-to-b');
    expect(rungs.filter((d) => d.className.includes('bg-gradient-to-b'))).toHaveLength(1);
  });

  it('목록(view=list) 뷰에서는 축척 브레드크럼이 "스토리"를 활성으로 보인다 — 이전엔 "건물"(작업)로 오매핑됐다(#3111)', async () => {
    currentSearch = 'view=list';
    await renderFlowClient();

    const rungs = Array.from(container.querySelector('.flex.overflow-hidden')?.children ?? []);
    const streetRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_street));
    const buildingRung = rungs.find((d) => d.textContent?.includes(koMessages.flow.ladderName_building));
    expect(streetRung?.className).toContain('bg-gradient-to-b');
    expect(buildingRung?.className).not.toContain('bg-gradient-to-b');
    expect(rungs.filter((d) => d.className.includes('bg-gradient-to-b'))).toHaveLength(1);
  });
});

// story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — TopBar 타이틀=Heading
// 무게로 재분류(크기는 TopBar 유지·구조 불변).
// story #3101(Board IA 1단계 B, 명명 정합) — 탭 이름(sidebar "보드")과 페이지 타이틀이
// 그동안 갈려 있었다("흐름"). 첫 착지 렌더가 list(칸반)로 바뀐 것과 한 이름 계열로 맞춘다.
describe('FlowPageClient — 페이지 타이틀 "보드"(story #3101 명명 정합)', () => {
  it('TopBar 타이틀 h1 텍스트가 "보드"다(탭 이름과 동일 계열, 예전 "흐름" 아님)', async () => {
    await renderFlowClient();

    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toBe(koMessages.flow.title);
    expect(h1?.textContent).toBe('보드');
    expect(h1?.textContent).not.toBe('흐름');
  });
});

describe('FlowPageClient — TopBar 타이틀 Heading 무게(story #2969 PR-5)', () => {
  it('TopBar 타이틀 h1이 font-extrabold를 갖고 크기(text-sm)는 그대로다', async () => {
    await renderFlowClient();

    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1?.className).toContain('font-extrabold');
    expect(h1?.className).toContain('text-sm');
    expect(h1?.className).not.toContain('font-medium');
  });

  // story #2974 §1/§3(PR-D0) — 페이스(family)는 무게와 별개 축으로 font-display 토큰 경유
  // (D0=Pretendard, 시각 무변화 — 세리프 전환 시 이 타이틀도 함께 전환되게 하는 배선).
  it('TopBar 타이틀 h1이 font-display 토큰도 경유한다(#2974 D0 배선, 무게와 무관)', async () => {
    await renderFlowClient();

    const h1 = container.querySelector('h1');
    expect(h1?.className).toContain('font-display');
    expect(h1?.className).toContain('font-extrabold');
  });
});
