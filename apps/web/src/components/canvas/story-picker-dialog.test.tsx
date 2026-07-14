// @vitest-environment jsdom
//
// story 083176e8 — 까심 #2148 QA가 잡은 정확한 갭: 검색창이 존재하고 fetch도 나가지만 `q`가
// 실제 요청 URL에 안 실려(ApiStoryRepository.list()에서 소실) 무필터 결과만 반환하는 "장식"
// 상태였다. 이 스위트는 그 정확한 실패 모드를 재현 가능한 형태로 봉쇄한다 — fetch를 스파이해
// 요청 URL에 q가 실제로 실리는지, 그리고 응답이 그 q에 따라 달라지는 것을 UI가 실제로
// 반영하는지(정적 목록이 아니라)까지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryPickerDialog } from './story-picker-dialog';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

// query에 따라 다른 결과를 돌려주는 스텁 — 실제 BE(title ILIKE)를 흉내(전체목록≠필터목록이라야
// "검색이 실제로 필터링한다"를 증명할 수 있다, 정적 응답으로는 장식/실동작을 구분 못 함).
const ALL_STORIES = [
  { id: 's1', title: '로그인 화면 개선' },
  { id: 's2', title: '결제 플로우 리팩터' },
  { id: 's3', title: '로그인 다국어 대응' },
];

function stubFetch() {
  fetchMock = vi.fn(async (url: string) => {
    const q = new URL(url, 'http://localhost').searchParams.get('q');
    const data = q ? ALL_STORIES.filter((s) => s.title.includes(q)) : ALL_STORIES;
    return { ok: true, status: 200, json: async () => ({ data }) };
  }) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
}

async function mount(props: Partial<React.ComponentProps<typeof StoryPickerDialog>> = {}) {
  await act(async () => {
    root.render(wrap(
      <StoryPickerDialog open onOpenChange={vi.fn()} projectId="proj-1" onSelect={vi.fn()} {...props} />,
    ));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // 초기 무쿼리 fetch 플러시
}

describe('StoryPickerDialog — 검색 실배선(story 083176e8, 까심 #2148 QA 정정)', () => {
  it('초기 오픈 시 project_id만 실려 무쿼리 전체 목록을 보여준다', async () => {
    stubFetch();
    await mount();
    expect(document.body.textContent).toContain('로그인 화면 개선');
    expect(document.body.textContent).toContain('결제 플로우 리팩터');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain('q=');
  });

  it('입력한 검색어가 실제 요청 URL의 q 파라미터에 실린다(장식 재발 방지 — 정확히 까심이 잡은 지점)', async () => {
    stubFetch();
    await mount();
    const input = document.body.querySelector('input') as HTMLInputElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '로그인');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // 디바운스 플러시

    const lastCall = fetchMock.mock.calls.at(-1)![0] as string;
    expect(lastCall).toContain(`q=${encodeURIComponent('로그인')}`);
  });

  it('검색 결과가 실제로 필터된 값을 렌더한다(정적 목록이 아니라 응답 그대로 반영 — 장식이면 이 테스트가 잡는다)', async () => {
    stubFetch();
    await mount();
    const input = document.body.querySelector('input') as HTMLInputElement;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '로그인');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    expect(document.body.textContent).toContain('로그인 화면 개선');
    expect(document.body.textContent).toContain('로그인 다국어 대응');
    expect(document.body.textContent).not.toContain('결제 플로우 리팩터');
  });

  it('clicking a story fires onSelect with its id', async () => {
    stubFetch();
    const onSelect = vi.fn();
    await mount({ onSelect });
    const storyButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent === '로그인 화면 개선')!;
    await act(async () => { storyButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelect).toHaveBeenCalledWith('s1');
  });
});
