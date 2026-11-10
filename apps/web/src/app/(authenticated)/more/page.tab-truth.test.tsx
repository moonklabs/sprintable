// @vitest-environment jsdom
//
// story #4278(유나 결정 ①②) — 플래그 ON(탭 = 오늘 · 대화 · 일감 · 전체)에서 전체 메뉴가 실제 탭과 한 세계인지 실 렌더로 잰다.
// ① 머리 안내의 탭 이름 = 탭바가 그리는 탭(ko 「」· · en 목록 접속) ② 결재함은 «오늘» 구역 · «오늘»(org-briefing) 항목은 메뉴에 없음
// ③ «연결·규칙» 머리 한 번 · 첫 항목 «모아 보기». 뮤테이션: page.tsx가 flags를 안 읽으면(OFF 고정) ①②가 RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import enMessages from '../../../../messages/en.json';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 1024 }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ navV3Flags: { todayV3Enabled: true, chatV3Enabled: true, connectRulesV3Enabled: true }, orgMemberships: [], projectMemberships: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function mount(locale: 'ko' | 'en') {
  const { default: MorePage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <TopBarProvider><MorePage /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
}

describe('전체 메뉴 — 플래그 ON에서 실제 탭과 한 세계(story #4278)', () => {
  it('⭐머리 안내 ko: 「오늘」·「대화」·「일감」 · en: "Today", "Chats", and "Work"', async () => {
    await mount('ko');
    expect(container.querySelector('[data-testid="more-tab-hint"]')?.textContent).toBe('아래 탭(「오늘」·「대화」·「일감」)에 있는 화면은 여기엔 없어요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await mount('en');
    expect(container.querySelector('[data-testid="more-tab-hint"]')?.textContent)
      .toBe(`Screens in the tabs below ("${enMessages.nav.zoneNow}", "${enMessages.nav.chats}", and "${enMessages.nav.zoneDev}") aren't listed here`);
  });

  // story #4885 — 탭이 «오늘»을 그리는 판(ON)에서도 메뉴는 탭에 없는 목적지를 반드시 갖는다: «오늘»(org-briefing)은 탭에 있어 메뉴에 없고, «결재»(inbox)는 탭에 없어 메뉴에 남는다.
  it('⭐결재는 메뉴에 남고 · «오늘» 항목(org-briefing)은 탭에 있으니 메뉴에 없음', async () => {
    await mount('ko');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/inbox?tab=gates');
    expect(hrefs).not.toContain('/org-briefing');
    expect(container.textContent).not.toContain(koMessages.nav.descOrgBriefing);
  });

  it('⭐새 구조 — «조직» 머리 한 번 · 연결 · 규칙 항목들이 그 안 · 에이전트 구역에 실행 기록 · API 키', async () => {
    await mount('ko');
    const headings = [...container.querySelectorAll('h2')].map((el) => el.textContent?.trim());
    expect(headings.filter((h) => h === koMessages.nav.zoneOrganization)).toHaveLength(1);
    const orgCard = [...container.querySelectorAll('h2')].find((h) => h.textContent?.startsWith(koMessages.nav.zoneOrganization))!.closest('[class*="overflow-hidden"]')!;
    const orgNames = [...orgCard.querySelectorAll('a span.block.truncate')].map((el) => el.textContent);
    expect(orgNames).toEqual(expect.arrayContaining([koMessages.nav.orgChannels, koMessages.nav.orgGenerationConnectors, koMessages.nav.orgContentRules, koMessages.nav.orgEvents, koMessages.nav.orgTrust]));
    const teamCard = [...container.querySelectorAll('h2')].find((h) => h.textContent?.startsWith(koMessages.nav.workforce))!.closest('[class*="overflow-hidden"]')!;
    expect([...teamCard.querySelectorAll('a span.block.truncate')].map((el) => el.textContent))
      .toEqual([koMessages.nav.workforce, koMessages.nav.workforceRuns, koMessages.nav.workforceApiKeys]);
  });
});
