// @vitest-environment jsdom
//
// story #fddd0e6b(IA ⑦ 전체 메뉴 AC1) — 부제(「{n}개 화면 · {g}개 구역」)의 n·g는 렌더
// 결과에서 세야 한다(리터럴 21/7 금지). 진짜 이 자를 잡으려면 실 NAV_GROUPS 위에서 값이
// 우연히 맞는지가 아니라, **SSOT 자체를 바꿔도 부제가 따라 움직이는지**를 봐야 한다 —
// 이 파일은 nav-config.ts 전체를 가짜 소형 카탈로그로 모킹해 그 축을 단독 검증한다(다른
// page.test.tsx는 실 NAV_GROUPS를 그대로 써서 이 모킹과 서로 격리).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle } from 'lucide-react';
import koMessages from '../../../../messages/ko.json';

const FAKE_ICON = AlertCircle as LucideIcon;

// 실 nav-config.ts의 25항목/7구역과 다른 수(2구역·3항목)로 교체 — 부제가 이 가짜 값을
// 그대로 따라가면(하드코딩이 아니라 실제로 렌더 결과를 센다는 뜻) 이 테스트가 통과한다.
vi.mock('@/lib/nav-config', () => ({
  NAV_GROUPS: [
    {
      id: 'fake-a', labelKey: 'zoneNow',
      items: [
        { id: 'fake-item-1', labelKey: 'orgBriefing', descriptionKey: 'descOrgBriefing', icon: FAKE_ICON, kind: 'static', path: '/fake-1' },
        { id: 'fake-item-2', labelKey: 'inbox', descriptionKey: 'descInbox', icon: FAKE_ICON, kind: 'static', path: '/fake-2' },
      ],
    },
    {
      id: 'fake-b', labelKey: 'zoneDev',
      items: [
        { id: 'fake-item-3', labelKey: 'goals', descriptionKey: 'descGoals', icon: FAKE_ICON, kind: 'resource', path: 'fake-3' },
      ],
    },
  ],
  MOBILE_HUB_GROUP_ORDER: ['fake-a', 'fake-b'],
  MOBILE_HUB_EXCLUDE_IDS: new Set<string>(),
  // story #4885 — more/page.tsx가 «그 밖의 화면» 카드를 OTHER_NAV_ITEMS로 만든다. 이 파일의 목적은 어디까지나 "SSOT를 바꾸면 부제가 따라 움직인다"는 축 단독검증이라
  // 빈 배열로 둬 3구역째(그 밖) 가 안 생기게 한다(2구역·3항목 가짜 카탈로그 전제를 그대로 보존).
  OTHER_NAV_ITEMS: [],
  // story #4278 — more/page.tsx는 이제 사이드바와 같은 resolveNavGroups(flags)로 구역을 얻는다(플래그별 목적지). 이 파일의
  // 가짜 카탈로그를 그대로 돌려준다(위 NAV_GROUPS와 같은 두 구역 · 세 항목).
  resolveNavGroups: () => [
    {
      id: 'fake-a', labelKey: 'zoneNow',
      items: [
        { id: 'fake-item-1', labelKey: 'orgBriefing', descriptionKey: 'descOrgBriefing', icon: AlertCircle, kind: 'static', path: '/fake-1' },
        { id: 'fake-item-2', labelKey: 'inbox', descriptionKey: 'descInbox', icon: AlertCircle, kind: 'static', path: '/fake-2' },
      ],
    },
    {
      id: 'fake-b', labelKey: 'zoneDev',
      items: [
        { id: 'fake-item-3', labelKey: 'goals', descriptionKey: 'descGoals', icon: AlertCircle, kind: 'resource', path: 'fake-3' },
      ],
    },
  ],
}));

// story 4890: «새 소식» (the release notes context) is read by the shortcuts block — its state is set per test
const notes = vi.hoisted(() => ({ value: null as null | { open: () => void; hasUnseen: boolean } }));
vi.mock('@/components/release-notes/release-notes-gate', () => ({ useReleaseNotes: () => notes.value }));

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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

// story 4890 (UI-7 · «전체» 화면 통째): the «{n}개 화면 · {g}개 구역» line is gone — the page starts with ONE search row and goes straight to the sections (before: a count line + two tab-hint lines + two search widgets used 28% of the screen before the first section).
describe('MorePage — 첫 내용 앞이 한 줄 검색뿐이다(story 4890)', () => {
  it('⭐개수 줄(more-subtitle)이 없고, 검색 한 줄 바로 다음이 구역이다(가짜 카탈로그 2구역 · 3항목)', async () => {
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<TopBarProvider><MorePage /></TopBarProvider>)); });
    expect(container.querySelector('[data-testid="more-subtitle"]')).toBeNull();
    const cards = [...container.querySelectorAll('[data-testid="more-section-card"]')];
    expect(cards).toHaveLength(2);
    const input = container.querySelector('[data-testid="more-search-input"]')!;
    // the search row is the first thing: nothing but it sits before the first section card in document order
    const before = [...container.querySelectorAll('p')].filter((p) => (p.compareDocumentPosition(cards[0]!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    expect(before).toEqual([]);
    expect(input.compareDocumentPosition(cards[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

// story 4890 — the two header buttons that left the phone header row (people · what's new) are the first card here: same names, same opening, drawn only on a width with a tab bar (<lg), only where their context exists.
describe('MorePage — 머리줄에서 옮겨 온 «팀 현황 · 새 소식» 두 줄(story 4890)', () => {
  async function drawWith(presence: { toggle: () => void; workingCount: number; open: boolean } | null, news: { open: () => void; hasUnseen: boolean } | null) {
    notes.value = news;
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    const { TeamPresenceToggleProvider } = await import('@/components/presence/team-presence-toggle');
    await act(async () => { root.render(wrap(<TopBarProvider><TeamPresenceToggleProvider value={presence}><MorePage /></TeamPresenceToggleProvider></TopBarProvider>)); });
  }

  it('both contexts → a card of two rows above the sections, hidden from lg up (the header row keeps them there); a press runs the same open', async () => {
    const toggle = vi.fn(); const open = vi.fn();
    await drawWith({ toggle, workingCount: 3, open: false }, { open, hasUnseen: true });
    const card = container.querySelector('[data-testid="more-shell-shortcuts"]')!;
    expect(card.className.split(/\s+/)).toContain('lg:hidden');
    expect(card.compareDocumentPosition(container.querySelector('[data-testid="more-section-card"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const presence = container.querySelector<HTMLButtonElement>('[data-testid="more-shortcut-presence"]')!;
    expect(presence.textContent).toContain(koMessages.presence.panelTitle);
    expect(presence.textContent).toContain('3'); // the working count, as the header button's badge
    expect(presence.getAttribute('aria-label')).toBe(koMessages.presence.fabLabelWorking.replace('{count}', '3')); // the number is in the button's own name (the badge is hidden from the reader — no double announcement)
    expect(presence.querySelector('[data-slot="ds-count-badge"]')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { presence.click(); });
    expect(toggle).toHaveBeenCalledTimes(1);
    const news = container.querySelector<HTMLButtonElement>('[data-testid="more-shortcut-news"]')!;
    await act(async () => { news.click(); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('no context (outside the providers) → no row, and with neither no card at all', async () => {
    await drawWith(null, null);
    expect(container.querySelector('[data-testid="more-shell-shortcuts"]')).toBeNull();
  });

  it('only the context that exists draws its row', async () => {
    await drawWith({ toggle: () => {}, workingCount: 0, open: false }, null);
    expect(container.querySelector('[data-testid="more-shortcut-presence"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="more-shortcut-news"]')).toBeNull();
  });
});
