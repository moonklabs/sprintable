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

function stubStories(rows: BoardBridgeStory[], meta: { hasMore: boolean; nextCursor: string | null } = { hasMore: false, nextCursor: null }) {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: rows, meta }) });
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

  it('보드 해제 후 같은 보드 재선택 — stale loadedKey 재사용으로 즉시 오단정하지 않는다(카디르 QA blocker②)', async () => {
    fetchWithAuthMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: [story('s1', '보드1 스토리')] }) }));
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard(BOARD.projectId);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리');

    await selectBoard(''); // 보드 해제.
    await selectBoard(BOARD.projectId); // 같은 보드 재선택 — loadedKey가 `p1|` 그대로면 즉시 settled 오판.
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeNoStories);

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리'); // 재fetch 정착 後 정상 표시.
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

  it('보드 A→B→A를 디바운스 안에서 왕복 — 옛 loadedKey 우연 일치로 즉시 정착 오단정하지 않는다(카디르 재-QA blocker②-2 a)', async () => {
    let boardACalls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const isBoard1 = url.includes(`project_id=${BOARD.projectId}`);
      if (isBoard1) {
        boardACalls += 1;
        return { ok: true, json: async () => ({ data: [story('s1', `보드1 스토리 v${boardACalls}`)] }) };
      }
      return { ok: true, json: async () => ({ data: [story('s2', '보드2 스토리')] }) };
    });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD, BOARD_2]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard(BOARD.projectId);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리 v1'); // A 최초 정착.

    await selectBoard(BOARD_2.projectId); // 디바운스(250ms) 안에서 B로.
    await selectBoard(BOARD.projectId); // 그 250ms 안에 다시 A — 파생 키는 최초 정착 때의 `p1|`와 우연히 같다.
    const staleButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('보드1 스토리'));
    expect(staleButton).toBeUndefined(); // v1(옛 응답)을 "정착"으로 오판해 보여주면 안 된다 — 새 응답 前엔 스켈레톤.

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리 v2'); // 이번 A 선택 «자신의» 새 응답이 도착한 後에만 정착.
  });

  it("검색어를 ''→'x'→''로 디바운스 안에서 왕복 — 옛 loadedKey 우연 일치로 즉시 정착 오단정하지 않는다(카디르 재-QA blocker②-2 b)", async () => {
    let emptyQueryCalls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://localhost').searchParams.get('q');
      if (!q) {
        emptyQueryCalls += 1;
        return { ok: true, json: async () => ({ data: [story('s1', `보드1 스토리 v${emptyQueryCalls}`)] }) };
      }
      return { ok: true, json: async () => ({ data: [story('s2', 'x 검색결과')] }) };
    });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard(BOARD.projectId);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리 v1'); // 빈 질의 최초 정착.

    act(() => { typeQuery('x'); }); // 디바운스 안에서 검색어 입력.
    act(() => { typeQuery(''); }); // 250ms 안에 다시 빈 문자열로 — 파생 키가 최초 정착 때의 `p1|`와 우연히 같다.
    const staleButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('보드1 스토리'));
    expect(staleButton).toBeUndefined();

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain('보드1 스토리 v2'); // 이번 왕복 «자신의» 새 응답이 도착한 後에만 정착.
  });
});

// story #3706(FE 완전성-정직) — limit=40 오버페치로 프록시가 항상 주는 meta.hasMore를
// 예전엔 json?.data만 읽고 버렸다 — 일치가 40건을 넘어도 검색 상자가 있다는 이유만으로
// "이게 전부"로 보였다. hasMore 조건부 한 줄 왕복 검증.
describe('BoardBridgeModal — hasMore 조건부 한 줄(story #3706)', () => {
  it('meta.hasMore=true면 「더 있음」 한 줄이 뜬다', async () => {
    stubStories([story('s1', '보드1 스토리')], { hasMore: true, nextCursor: 's99' });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).toContain(koMessages.standup.bridgeMoreResults);
  });

  it('meta.hasMore=false면 뜨지 않는다', async () => {
    stubStories([story('s1', '보드1 스토리')], { hasMore: false, nextCursor: null });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeMoreResults);
  });

  it('meta 자체가 없어도(규약 밖 응답) 죽지 않고 "더 없음"으로 안전하게 낙하한다(parseCursorMeta 위임)', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [story('s1', '보드1 스토리')] }) });
    await act(async () => {
      root.render(wrap(
        <BoardBridgeModal open onOpenChange={() => {}} boards={[BOARD]} alreadySelectedIds={[]} onSelectStory={() => {}} />,
      ));
    });
    await selectBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(document.body.textContent).not.toContain(koMessages.standup.bridgeMoreResults);
    expect(document.body.textContent).toContain('보드1 스토리');
  });
});
