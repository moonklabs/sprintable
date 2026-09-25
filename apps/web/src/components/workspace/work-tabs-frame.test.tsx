// @vitest-environment jsdom
// story #4291(유나 확정) — 일감 여섯 탭의 탭 줄은 `[ws]/[proj]` 레이아웃의 sticky 띠 하나(WorkTabsFrame). 여섯 탭 목록 화면에서만 띠 ·
// 켜진 탭 = 선택된 조각 · 로딩 사이 상단바 제목은 도착 탭 화면과 같은 글자(폴백 · 화면 슬롯이 이긴다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

const nav = vi.hoisted(() => ({ segments: ['flow'] as string[] }));
vi.mock('next/navigation', () => ({
  useSelectedLayoutSegments: () => nav.segments,
  useParams: () => ({ ws: 'my-ws', proj: 'my-proj' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function TitleProbe() {
  const { title, showContextChip } = useTopBar();
  return <div data-testid="topbar-title" data-chip={String(showContextChip)}>{title}</div>;
}

async function render(children: React.ReactNode = <div data-testid="page">page</div>) {
  const { WorkTabsFrame } = await import('./work-tabs-frame');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TitleProbe />
          <WorkTabsFrame>{children}</WorkTabsFrame>
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
}
const band = () => container.querySelector('[data-testid="work-tabs-band"]');
const selectedTab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const topTitle = () => container.querySelector('[data-testid="topbar-title"]')?.textContent;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('WorkTabsFrame — 일감 탭 줄 한 자리(story #4291)', () => {
  it.each([
    ['work-list', '목록'], ['flow', '보드'], ['sprints', '스프린트'], ['epics', '에픽'], ['retro', '회고'], ['hypotheses', '가설'],
  ])('⭐/%s — sticky 띠(px-4 pt-3) · 켜진 탭 %s · 탭은 a[href]', async (segment, label) => {
    nav.segments = [segment];
    await render();
    expect(band()).not.toBeNull();
    expect(band()!.className).toContain('sticky');
    expect(band()!.className).toContain('top-0');
    expect(band()!.className).toContain('px-4');
    expect(selectedTab()).toBe(label);
    const selected = container.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected.tagName).toBe('A');
    expect(selected.getAttribute('href')).toBe(`/my-ws/my-proj/${segment}`);
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  it.each([[['retro', 'session-1']], [['docs']], [['goals']], [[]]])('⭐%j — 여섯 탭 목록이 아니면 띠 없음(회고 상세 등 더 깊은 경로 포함)', async (segments) => {
    nav.segments = segments as string[];
    await render();
    expect(band()).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('⭐로딩 사이(화면 슬롯 없음) 상단바 제목 = 도착 탭 화면과 같은 글자 · 칩 표시 / 화면 슬롯이 붙으면 화면이 이긴다', async () => {
    nav.segments = ['sprints'];
    await render();
    expect(topTitle()).toBe(koMessages.sprints.title);
    expect(container.querySelector('[data-testid="topbar-title"]')!.getAttribute('data-chip')).toBe('true');
    await render(<TopBarSlot title={<h1>화면 제목</h1>} showContextChip />);
    expect(topTitle()).toBe('화면 제목');
  });

  it('탭마다 폴백 제목은 그 화면의 제목 키', async () => {
    const expected: Record<string, string> = {
      flow: koMessages.flow.title, 'work-list': koMessages.workList.title, sprints: koMessages.sprints.title,
      epics: koMessages.board.epicSwimlaneTitle, retro: koMessages.retro.title, hypotheses: koMessages.nav.hypothesis,
    };
    for (const [segment, title] of Object.entries(expected)) {
      nav.segments = [segment];
      await render();
      expect(topTitle(), segment).toBe(title);
    }
  });
});
