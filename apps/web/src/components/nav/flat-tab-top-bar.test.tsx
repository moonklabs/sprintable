// @vitest-environment jsdom
// story #4326 — «전체» · «결재» · «대화»로 옮기는 사이(loading.tsx가 뜬 동안) 상단바 제목 · 칩이 비었다. 각 loading이 도착 화면과 **같은
// 제목 컴포넌트**를 폴백으로 쥐고(칩 표시), 화면 슬롯이 붙으면 화면이 이긴다(4291 AC3과 같은 방식).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

const nav = vi.hoisted(() => ({ tab: null as string | null, segments: ['flow'] as string[], pathname: '/' as string }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.tab ? `tab=${nav.tab}` : ''),
  usePathname: () => nav.pathname,
  useSelectedLayoutSegments: () => nav.segments,
  useParams: () => ({ ws: 'my-ws', proj: 'my-proj' }),
}));
// 결재 loading의 선행 요청 조각은 이 검사와 무관 — 네트워크 없이 비운다.
vi.mock('@/components/inbox/inbox-prefetch-starter', () => ({ InboxPrefetchStarter: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { nav.tab = null; nav.pathname = '/'; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function TitleProbe() {
  const { title, showContextChip } = useTopBar();
  return <div data-testid="topbar-title" data-chip={String(showContextChip)}>{title}</div>;
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider>
          <TitleProbe />
          {node}
        </TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
}
const probe = () => container.querySelector('[data-testid="topbar-title"]') as HTMLElement;

describe('«전체» · «결재» · «대화» 로딩 사이 상단바 폴백(story #4326)', () => {
  it('⭐«전체»(/more) 로딩 — 제목 = 전체 메뉴 제목 · 칩 표시', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/more/loading');
    nav.pathname = '/more';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.nav.moreMenuTitle);
    expect(probe().querySelector('h1')).not.toBeNull();
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐«대화»(/chats) 로딩 — 제목 = 대화 제목 · 칩 표시', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/chats/loading');
    nav.pathname = '/chats';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.chats.title);
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐«결재»(/inbox) 로딩 — 도착 탭 이름(?tab=) · 기본은 알림 · 수는 아직 모르니 안 붙임', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/inbox/loading');
    nav.pathname = '/inbox';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.inbox.notificationsTabLabel);
    nav.tab = 'gates';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.cage.gateTabLabel);
    nav.tab = 'attention';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.inbox.attentionTabLabel);
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐«채널»(/channel) · «보상»(/rewards) 로딩 — 같은 «경로 → 제목» 표(PO 4688 · AC2 전수의 남은 둘)', async () => {
    const { default: ChannelLoading } = await import('@/app/(authenticated)/channel/loading');
    nav.pathname = '/channel';
    await render(<ChannelLoading />);
    expect(probe().textContent).toBe(koMessages.channel.title);
    expect(probe().dataset.chip).toBe('true');
    const { default: RewardsLoading } = await import('@/app/(authenticated)/rewards/loading');
    nav.pathname = '/rewards';
    await render(<RewardsLoading />);
    expect(probe().textContent).toBe(koMessages.rewards.title);
  });

  it('⭐«목표»([ws]/[proj]/goals) 로딩 — 제목 = 목표 · 칩 표시(PO 4688 · 유나 «전체» → «목표» 1440 290ms 빔)', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/[ws]/[proj]/goals/loading');
    nav.pathname = '/my-ws/my-proj/goals';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.goals.title);
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐«목표» — 동적 layout이 풀리는 동안 먼저 보이는 부모 경계([ws]/[proj]/loading)도 같은 폴백을 쥔다(유나 290ms의 앞 구간)', async () => {
    const { default: ParentLoading } = await import('@/app/(authenticated)/[ws]/[proj]/loading');
    nav.pathname = '/my-ws/my-proj/goals';
    await render(<ParentLoading />);
    expect(probe().textContent).toBe(koMessages.goals.title);
    expect(probe().dataset.chip).toBe('true');
  });

  it('⭐목록 전용 — 같은 loading이 덮는 상세(대화 하나 · 목표 하나)로 올 땐 목록 제목 · 칩을 세우지 않는다(상세는 제목이 다르고 칩이 없다)', async () => {
    const { default: ChatsLoading } = await import('@/app/(authenticated)/chats/loading');
    nav.pathname = '/chats/conv-1';
    await render(<ChatsLoading />);
    expect(probe().textContent).toBe('');
    expect(probe().dataset.chip).toBe('false');
    const { default: GoalsLoading } = await import('@/app/(authenticated)/[ws]/[proj]/goals/loading');
    nav.pathname = '/my-ws/my-proj/goals/epic-1';
    await render(<GoalsLoading />);
    expect(probe().textContent).toBe('');
  });

  it('⭐표의 모든 경로가 자기 loading.tsx에서 그 표로 폴백을 쥔다(새 경로를 표에만 넣고 로딩을 빠뜨리면 RED)', async () => {
    const { FLAT_ROUTE_TOP_BAR } = await import('./flat-tab-top-bar');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    for (const route of Object.keys(FLAT_ROUTE_TOP_BAR)) {
      const file = path.resolve(__dirname, `../../app/(authenticated)/${route}/loading.tsx`);
      expect(readFileSync(file, 'utf8'), `${route}/loading.tsx`).toContain(`<RouteTopBarFallback route="${route}" />`);
    }
  });

  it('화면 슬롯이 붙으면 화면이 이긴다(폴백은 슬롯이 빈 사이에만)', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/more/loading');
    nav.pathname = '/more';
    await render(<><Loading /><TopBarSlot title={<h1>화면 제목</h1>} showContextChip={false} /></>);
    expect(probe().textContent).toBe('화면 제목');
    expect(probe().dataset.chip).toBe('false');
  });

  it('⭐«보드»(일감 레이아웃 안) → «전체» — 떠나는 일감 탭 폴백의 늦은 정리가 도착 폴백을 지우지 않는다(PO 4688 · 유나 prod 실측 ~300ms 빈 상단바)', async () => {
    // 한 커밋 안에서: 도착 로딩의 폴백은 layout effect로 먼저 서고, 떠나는 일감 탭 폴백의 정리는 passive effect라 그 **뒤**에 돈다.
    // 정리가 «남의 폴백»까지 비우면 상단바가 통째로 빈다 — 폴백은 자기가 세운 것만 치운다.
    const { WorkTabsFrame } = await import('@/components/workspace/work-tabs-frame');
    const { default: MoreLoading } = await import('@/app/(authenticated)/more/loading');
    await render(<WorkTabsFrame><div /></WorkTabsFrame>);
    expect(probe().textContent).not.toBe('');
    nav.pathname = '/more';
    await render(<MoreLoading />);
    expect(probe().textContent).toBe(koMessages.nav.moreMenuTitle);
    expect(probe().dataset.chip).toBe('true');
  });

  it('로딩이 떠나면 폴백을 비운다(다음 화면에 옛 제목이 남지 않게)', async () => {
    const { default: Loading } = await import('@/app/(authenticated)/chats/loading');
    nav.pathname = '/chats';
    await render(<Loading />);
    expect(probe().textContent).toBe(koMessages.chats.title);
    await render(null);
    expect(probe().textContent).toBe('');
  });
});
