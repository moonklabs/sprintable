// @vitest-environment jsdom
//
// story #3431(공용, PO 確定 2026-09-05) — 그라운딩 중 발견한 3번째 복사본(chat/approvals
// 카운트 배지, `CircleDot`/`Inbox` 옆이 아니라 오른쪽 옆에 얹는 위치)을 공용
// 공용 배지로 통합했다(4890부터 ds CountBadge) — 색·크기·값 상한(9+/99+) 로직은 무변경, 위치와 정의만 접었다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/flow',
}));
// story #4885 — 「홈」 탭 배지는 홈 모델(useHomeModel) 하나를 읽는다(웹 막대 「홈」 배지와 같은 수). 모델 값만 시험이 정한다.
const { homeState } = vi.hoisted(() => ({ homeState: { badge: 0, partial: false } }));
vi.mock('@/components/home/home-model-provider', () => ({
  useHomeModel: () => ({ model: { badge: homeState.badge }, sources: null, loadError: false, partial: homeState.partial, retry: () => {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(homeBadge: number, chatUnreadTotal: number, locale: 'ko' | 'en' = 'ko', flags?: import('@/lib/nav-v3-destinations').NavV3Flags, partial = false) {
  homeState.badge = homeBadge;
  homeState.partial = partial;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { MobileTabBar } = await import('./mobile-tab-bar');
  await act(async () => { root.render(wrap(<MobileTabBar chatUnreadTotal={chatUnreadTotal} navV3Flags={flags} />, locale)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const countText = (el: Element | null) => { if (!el) return null; const c = el.cloneNode(true) as Element; c.querySelectorAll('.sr-only').forEach((n) => n.remove()); return (c.textContent ?? '').trim(); };
const BADGE = '[data-slot="ds-count-badge"]';

describe('MobileTabBar — 홈(내 손이 필요한 일)/채팅 카운트 배지(story #3431 · #4885 홈 모델 · 4890 UI-7: ds CountBadge 한 정의)', () => {
  it('두 배지 모두 0건이면 배지 자체가 안 뜬다', async () => {
    await mount(0, 0);
    expect(container.querySelector(BADGE)).toBeNull();
  });

  it('홈 5건 — ds CountBadge «내 손이 필요»(호박) · 아이콘 옆 자리 · 화면 읽기에선 숨김(수는 링크 이름이 전함)', async () => {
    await mount(5, 0);
    const badge = container.querySelector(BADGE);
    expect(countText(badge)).toBe('5');
    expect(badge?.getAttribute('data-kind')).toBe('needs-hand');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    expect(badge?.className).toContain('absolute');
    expect(badge?.className).toContain('left-full');
    expect(badge?.className).not.toContain('text-micro'); // the old 10px corner badge is gone
  });

  it('홈 12건 — 그대로 12(웹 막대와 같은 수 · 예전 9+ 상한은 걷었다)', async () => {
    await mount(12, 0);
    expect(countText(container.querySelector(BADGE))).toBe('12');
  });

  it('홈 150건 — 웹 막대와 같은 99+ 상한', async () => {
    await mount(150, 0);
    expect(countText(container.querySelector(BADGE))).toBe('99+');
  });

  it('⭐홈 읽기가 불완전(partial) 5건 — «5+»(웹 막대 atLeast와 같은 규칙)', async () => {
    await mount(5, 0, 'ko', undefined, true);
    expect(countText(container.querySelector(BADGE))).toBe('5+');
  });

  it('채팅 unread 150건 — 99+ 상한(기존 로직 무변경, 결재와 다른 캡)', async () => {
    await mount(0, 150);
    const badge = container.querySelector(BADGE);
    expect(countText(badge)).toBe('99+');
    expect(badge?.getAttribute('data-kind')).toBe('unread');
  });
});

// story #3518(유나 사전 스티어, 2026-09-05) — 배지는 aria-hidden이라 그 수를 보조
// 기술에 전하는 책임은 탭 링크에 있다. aria-label(접근성 이름 통째 교체)은 안 쓴다 —
// 이 탭은 보이는 텍스트 라벨("대화"·"홈")이 있어서 aria-label로 갈아치우면 WCAG
// 2.5.3(Label in Name) 위반이다. 대신 보이는 라벨 뒤에 sr-only 텍스트를 "덧붙인다" —
// 접근성 이름은 여전히 라벨+children 텍스트 전체(배지의 aria-hidden 텍스트는 accname
// 계산에서 제외)로 계산된다. jsdom엔 실 accname 알고리즘이 없어 아래 헬퍼로 근사한다
// (aria-hidden 하위 텍스트를 제외한 텍스트 concat — 이 파일의 마크업 깊이에선 충분).
function collectVisibleText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (child.getAttribute('aria-hidden') === 'true') continue;
      out += collectVisibleText(child);
    }
  }
  return out;
}

// 재귀 도중엔(하위 호출마다) 다듬지 않는다 — 각 레벨에서 trim하면 "대화"+" 읽지…"의
// 경계 공백이 하위 호출 안에서 먼저 잘려 "대화읽지…"처럼 붙어버린다(실제 겪은 버그).
// 정규화는 최종 문자열에서 한 번만.
function approxAccessibleName(el: Element): string {
  return collectVisibleText(el).replace(/\s+/g, ' ').trim();
}

describe('MobileTabBar — 탭 접근성 이름에 카운트 포함(story #3518)', () => {
  it('배지 0건 — sr-only 텍스트가 안 붙는다(접근성 이름=보이는 라벨 그대로)', async () => {
    await mount(0, 0);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    // story #3824 CHANGES② — chat 탭 라벨이 nav.chats 공유로 "채팅"→"대화"(허브·바텀탭 통일).
    expect(approxAccessibleName(chatLink)).toBe('대화');
    expect(chatLink.getAttribute('aria-label')).toBeNull(); // 접근성 이름을 통째로 안 갈아치운다(WCAG 2.5.3).
  });

  // story #4885(폰 탭 넷) — «결재» 탭이 없어졌고 «홈» 탭 배지 = 홈 모델의 «내 손이 필요한 일» 수. 접근성 이름 = 보이는 라벨 «홈» + 수 문장.
  it('홈 5건 — «홈» 탭의 접근성 이름이 «보이는 라벨+수»(라벨을 안 지운다)', async () => {
    await mount(5, 0);
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(approxAccessibleName(approvalsLink)).toBe('홈 내 손이 필요한 일 5건');
  });

  it('채팅 unread 3건 — 접근성 이름이 «보이는 라벨+수»', async () => {
    await mount(0, 3);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('대화 안읽음 3건');
  });

  it('홈 150건(시각 99+ 표기) — 접근성 이름엔 «99건 이상»(캡을 말로 반영)', async () => {
    await mount(150, 0);
    const home = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(approxAccessibleName(home)).toBe('홈 내 손이 필요한 일 99건 이상');
  });

  it('홈 partial 5건(시각 5+) — 접근성 이름엔 «5건 이상»', async () => {
    await mount(5, 0, 'ko', undefined, true);
    const home = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(approxAccessibleName(home)).toBe('홈 내 손이 필요한 일 5건 이상');
  });

  it('채팅 unread 150건(시각 99+ 표기) — 접근성 이름엔 "99건 이상"', async () => {
    await mount(0, 150);
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(approxAccessibleName(chatLink)).toBe('대화 안읽음 99건 이상');
    const badge = container.querySelector(BADGE);
    expect(countText(badge)).toBe('99+');
    expect(badge?.getAttribute('data-kind')).toBe('unread');
  });

  // story #3518(유나 사전 스티어 H, PO 決定) — 홈 sr 문구는 EN에서 셀 수 있는 명사("thing")라 ICU plural이 실제로 갈린다(1 vs 그 외). 채팅 "unread"는
  // 형용사성이라 단수·복수 형태 차이가 없다(그래도 count=1 경계값은 확인).
  it('[en] 홈 1건 — ICU plural one 갈래(단수)', async () => {
    await mount(1, 0, 'en');
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(approxAccessibleName(approvalsLink)).toBe('Home 1 thing needs your hand');
  });

  it('[en] 홈 5건 — ICU plural other 갈래(복수)', async () => {
    await mount(5, 0, 'en');
    const approvalsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(approxAccessibleName(approvalsLink)).toBe('Home 5 things need your hand');
  });

  it('[en] 채팅 unread 1건 — "1 unread"(형태 안 갈림, count=1 경계값 확인)', async () => {
    await mount(0, 1, 'en');
    const chatLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    // story #3824 CHANGES② — chat 탭 라벨이 nav.chats 공유로 "Chat"→"Chats".
    expect(approxAccessibleName(chatLink)).toBe('Chats 1 unread');
  });

  // 폰 탭 넷(story #4885) — 탭 세트는 플래그로 갈리지 않는다: v3 «오늘» 화면이 켜져 있으면 «홈» 탭이 /today에 착지하고 배지 · 접근 이름은 그대로다(codex 권고).
  it('⭐v3 오늘 화면 ON(/today) — «홈» 탭이 /today에 착지하고 같은 홈 배지 · 접근 이름', async () => {
    await mount(5, 0, 'ko', { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false });
    const home = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/today')!;
    expect(home).toBeDefined();
    expect(approxAccessibleName(home)).toBe('홈 내 손이 필요한 일 5건');
    expect([...container.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/org-briefing')).toBe(false);
  });
});

// story #4885 — 홈 모델 공급자가 없는 셸 밖 화면(v3 시안 /today · /chat · /connect-rules — 환경 플래그가 꺼진 기본에선 안 선다)에 이 탭바가 얹히면: 오류 없이 렌더되고 «홈» 배지는 없다.
describe('MobileTabBar — 홈 모델 공급자 없음(셸 밖 v3 화면, story #4885)', () => {
  it('공급자 없이 렌더돼도 오류 없이 탭 넷이 서고 «홈» 배지는 안 뜬다(대화 배지는 그대로)', async () => {
    vi.resetModules();
    vi.doUnmock('@/components/home/home-model-provider');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const { MobileTabBar } = await import('./mobile-tab-bar');
    await act(async () => { root.render(wrap(<MobileTabBar chatUnreadTotal={4} />)); });
    expect(container.querySelectorAll('[data-testid="mobile-tab-bar"] a')).toHaveLength(4);
    const home = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/org-briefing')!;
    expect(home.querySelector('span[aria-hidden]')).toBeNull();
    const chat = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/chats')!;
    expect(chat.querySelector('span[aria-hidden]')?.textContent).toBe('4');
  });
});
