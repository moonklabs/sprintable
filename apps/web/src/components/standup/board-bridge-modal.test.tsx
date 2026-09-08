// @vitest-environment jsdom
//
// story #3703(FE 완전성-정직, 유나 § 2026-09-08) — board-bridge-modal.tsx가 project_id당
// limit=40 단발 fetch뿐이라 40번째 밖 story는 이 픽커로 영영 못 골랐다(이 프로젝트만
// 3700+건 실측). story-picker-dialog.tsx(canvas) 패턴을 이식한 검색 입력(250ms 디바운스+
// `q` 파라미터)이 실제로 쿼리를 실어 보내는지, 빈 상태가 질의 유무로 정확히 갈리는지 검증.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoardBridgeModal, type BoardBridgeBoard, type BoardBridgeStory } from './board-bridge-modal';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function story(id: string, title: string): BoardBridgeStory {
  return { id, title, status: 'backlog' };
}

const BOARD: BoardBridgeBoard = { projectId: 'p1', projectName: 'Sprintable' };
const BOARD_2: BoardBridgeBoard = { projectId: 'p2', projectName: 'Landing' };

let container: HTMLDivElement;
let root: Root;

function stubStories(rows: BoardBridgeStory[]) {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: rows }) });
}

async function selectBoard(projectId: string = BOARD.projectId) {
  const select = document.body.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, projectId);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function typeQuery(text: string) {
  const input = document.body.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchWithAuthMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BoardBridgeModal — 검색(story #3703, 40건 상한 도달성)', () => {
  it('스토리를 검색하면 q 파라미터를 실어 fetch한다(250ms 디바운스)', async () => {
    stubStories([story('s1', '검색된 스토리')]);
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fetchWithAuthMock.mockClear();

    act(() => { typeQuery('검색어'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    const calledUrl = fetchWithAuthMock.mock.calls.at(-1)?.[0] as string;
    expect(calledUrl).toContain('q=%EA%B2%80%EC%83%89%EC%96%B4'); // encodeURIComponent('검색어')
    expect(calledUrl).toContain('limit=40'); // 유나 明示 — 상한은 그대로, 검색이 도달을 보장.
  });

  it('질의 있는데 결과 0건 — "검색 결과가 없습니다"(질의 분기)', async () => {
    stubStories([story('s1', '기존 스토리')]);
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    stubStories([]); // 다음 fetch(검색)는 0건.
    act(() => { typeQuery('없는스토리'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    expect(document.body.textContent).toContain(koMessages.standup.bridgeSearchNoResults);
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeNoStories);
  });

  it('질의 없는데 결과 0건 — 기존 "이 보드에는 스토리가 없습니다"(무회귀)', async () => {
    stubStories([]);
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    expect(document.body.textContent).toContain(koMessages.standup.bridgeNoStories);
  });

  it('검색 입력창이 렌더된다(placeholder=bridgeSearchPlaceholder)', async () => {
    stubStories([story('s1', 'A')]);
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    const input = document.body.querySelector('input') as HTMLInputElement;
    expect(input.placeholder).toBe(koMessages.standup.bridgeSearchPlaceholder);
  });
});

// story #3703 CHANGES(유나 재-design, 2026-09-08 — blocking) — 디바운스로 fetch를 250ms
// 지연시키며 setLoading(true)도 그 안에 들어가, 보드 선택/전환 직후 250ms 동안 loading=false
// 인데 stories/loadError는 이전 값 그대로였다. 그 창에서 화면이 "이 보드에 스토리가 없다"를
// 물어보지도 않고 단정하거나, A보드 목록이 B보드인 양 남아 그 행을 클릭하면
// onSelectStory(A스토리, B보드) 어긋난 짝으로 잘못된 연결이 실제로 생긴다.
describe('BoardBridgeModal — 디바운스 창 정직성(story #3703 CHANGES, 유나 재-design)', () => {
  it('보드 전환 직후(디바운스 만료 前)엔 이전 보드 목록도 "없습니다"도 안 보인다 — 스켈레톤만', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const isBoard1 = url.includes(`project_id=${BOARD.projectId}`);
      return { ok: true, json: async () => ({ data: isBoard1 ? [story('s1', '보드1 스토리')] : [] }) };
    });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD, BOARD_2]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard(BOARD.projectId);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리');

    // 보드 전환 — 디바운스(250ms)가 아직 안 지났다.
    await selectBoard(BOARD_2.projectId);
    expect(document.body.textContent).not.toContain('보드1 스토리'); // 이전 보드 목록이 남으면 안 됨.
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeNoStories); // 물어보지도 않고 단정 금지.
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeSearchNoResults);

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain(koMessages.standup.bridgeNoStories); // 이제(정착 後)는 정당.
  });

  it('전환 직후 창에서 목록 행 버튼 자체가 없다(잘못된 짝 클릭 원천 차단)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const isBoard1 = url.includes(`project_id=${BOARD.projectId}`);
      return { ok: true, json: async () => ({ data: isBoard1 ? [story('s1', '보드1 스토리')] : [story('s2', '보드2 스토리')] }) };
    });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD, BOARD_2]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard(BOARD.projectId);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    await selectBoard(BOARD_2.projectId);
    const staleButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('보드1 스토리'));
    expect(staleButton).toBeUndefined();
  });
});
