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

let container: HTMLDivElement;
let root: Root;

function stubStories(rows: BoardBridgeStory[]) {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: rows }) });
}

async function selectBoard() {
  const select = document.body.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, BOARD.projectId);
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
