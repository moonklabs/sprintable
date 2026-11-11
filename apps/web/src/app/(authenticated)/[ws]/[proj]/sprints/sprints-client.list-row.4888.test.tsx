// @vitest-environment jsdom
//
// story #4888(UI-5 스프린트 화면 본체 첫 조각) — 스프린트 목록의 손으로 만든 카드 행(<li onClick>, 키보드로 못 고름 · 선택은 색만)을 ds ListRow로 갈아 끼운다.
// 제목이 키보드로 닿는 단추가 되고(누르면 줄 전체 클릭과 같은 선택), 선택한 줄은 aria-current, 상태 · 지남 배지는 오른쪽, 날짜는 둘째 줄, «리포트 보기»는 단추 밖 링크.
// 새 기능 0 · 카드 일감 수 0(PO 11-11 결정 ① — 새 읽기가 들기 때문에 안 넣는다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (<div data-testid="top-bar">{title}{actions}</div>),
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({ WorkspaceFrameTabs: () => null }));
vi.mock('../standup/standup-client', () => ({ default: () => null }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const SPRINTS = [
  { id: 's1', title: '지난 스프린트', status: 'planning', start_date: '2020-01-01', end_date: '2020-01-14', report_doc_id: 'doc-9' },
  { id: 's2', title: '이번 스프린트', status: 'active', start_date: '2099-01-01', end_date: '2099-01-14' },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) return { ok: true, json: async () => ({ data: SPRINTS }) };
    if (typeof url === 'string' && url.includes('/api/stories')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: false, json: async () => null };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SprintsClient projectId="proj-1" orgId="org-1" /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const items = () => [...container.querySelectorAll('li')].filter((li) => li.querySelector('[data-slot="ds-list-row"]'));
const rowOf = (title: string) => items().find((li) => li.textContent?.includes(title))!;
const selectButton = (title: string) => rowOf(title).querySelector('button') as HTMLButtonElement;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('스프린트 목록 — ds ListRow(story #4888)', () => {
  it('⭐스프린트마다 ds ListRow 한 줄이다 — 손으로 만든 카드 모양(rounded-lg · border-primary · p-4)은 없다', async () => {
    await mount();
    expect(items()).toHaveLength(2);
    for (const li of items()) {
      expect(li.className).not.toMatch(/rounded-lg|border-primary|(^|\s)p-4(\s|$)/);
      expect(li.querySelectorAll('[data-slot="ds-list-row"]')).toHaveLength(1);
    }
  });

  it('⭐제목이 키보드로 닿는 진짜 단추다(type=button · 이름에 스프린트 제목) — 예전엔 <li onClick>이라 키보드로 못 골랐다', async () => {
    await mount();
    for (const title of ['지난 스프린트', '이번 스프린트']) {
      const b = selectButton(title);
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('data-slot')).toBe('ds-button'); // 손으로 쓴 raw button이 아니라 ds Button(가드 verify:no-new-raw-button)
      expect(b.textContent).toContain(title);
    }
  });

  it('⭐제목 단추를 누르면 그 스프린트가 선택되고 상세가 열린다 — 선택한 줄만 aria-current, 다른 줄을 고르면 옮겨 간다', async () => {
    await mount();
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).toBeNull();
    await act(async () => { selectButton('이번 스프린트').click(); });
    await flush();
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).not.toBeNull();
    const cur = (title: string) => rowOf(title).querySelector('[data-slot="ds-list-row"]')!.getAttribute('aria-current');
    expect(cur('이번 스프린트')).toBe('true');
    expect(cur('지난 스프린트')).toBeNull();
    await act(async () => { selectButton('지난 스프린트').click(); });
    await flush();
    expect(cur('지난 스프린트')).toBe('true');
    expect(cur('이번 스프린트')).toBeNull();
  });

  it('줄(li)을 눌러도 예전처럼 선택된다(마우스 — 줄 전체가 눌림 영역)', async () => {
    await mount();
    await act(async () => { rowOf('이번 스프린트').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).not.toBeNull();
  });

  it('⭐«리포트 보기»는 제목 단추 밖의 링크이고(단추 안에 링크 없음), 눌러도 스프린트가 선택되지 않는다', async () => {
    await mount();
    const link = rowOf('지난 스프린트').querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toContain(koMessages.sprints.viewReport);
    expect(link.closest('button')).toBeNull();
    expect(rowOf('이번 스프린트').querySelector('a')).toBeNull();
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flush();
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).toBeNull();
  });

  it('⭐상태 배지 · 지남 배지 · 날짜 · 기간(일)이 그대로 나온다 — 지난 줄만 «지남»', async () => {
    await mount();
    const past = rowOf('지난 스프린트').textContent ?? '';
    const cur = rowOf('이번 스프린트').textContent ?? '';
    expect(past).toContain(koMessages.sprints.statusPlanning); // 상태 배지: 계획 중
    expect(cur).toContain(koMessages.sprints.statusActive);    // 상태 배지: 진행 중
    expect(past).toContain('2020-01-01 ~ 2020-01-14');
    expect(past).toContain('지남');
    expect(cur).toContain('2099-01-01 ~ 2099-01-14');
    expect(cur).not.toContain('지남');
    expect(cur).toContain(`14${koMessages.sprints.days}`);
  });
});
