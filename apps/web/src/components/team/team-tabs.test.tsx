// @vitest-environment jsdom
//
// story #4885 (UI-2 AC4 · «팀» 탭줄) — 구성원 · 에이전트 · 실행 기록 · API 키 · 채용 한 줄. 되돌리면 RED: 탭을 빼거나 순서를 바꾸면 ① ② / 켜짐 판정을 바꾸면 ③ / 레이아웃에서 줄을 빼면 ④.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { pathnameRef, queryRef } = vi.hoisted(() => ({ pathnameRef: { current: '/organization/workforce' }, queryRef: { current: '' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(queryRef.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
const { TeamTabs } = await import('./team-tabs');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { pathnameRef.current = '/organization/workforce'; queryRef.current = ''; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><TeamTabs /></NextIntlClientProvider>);
  });
}
const tabs = () => [...container.querySelectorAll('[data-team-tab]')];
const current = () => tabs().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('data-team-tab'));

describe('«팀» 탭줄', () => {
  it('⭐순서와 이름: 에이전트 · 구성원 · 실행 기록 · API 키 · 채용 — 가는 화면이 이미 쓰는 낱말 그대로(ko)', async () => {
    await mount('ko');
    expect(tabs().map((a) => a.getAttribute('data-team-tab'))).toEqual(['agents', 'people', 'runs', 'keys', 'recruit']);
    expect(tabs().map((a) => a.textContent)).toEqual(['에이전트', '구성원', '실행 기록', 'API 키', '채용']);
    expect(tabs().map((a) => a.textContent)).toEqual([koMessages.nav.workforce, koMessages.nav.orgMembers, koMessages.nav.workforceRuns, koMessages.nav.workforceApiKeys, koMessages.agents.recruitTab]);
  });

  it('en 이름도 같은 키에서 나온다', async () => {
    await mount('en');
    expect(tabs().map((a) => a.textContent)).toEqual([enMessages.nav.workforce, enMessages.nav.orgMembers, enMessages.nav.workforceRuns, enMessages.nav.workforceApiKeys, enMessages.agents.recruitTab]);
  });

  it('⭐탭은 진짜 페이지 이동 링크 — 라우트 이동 0(구성원 /organization/members · 에이전트 /organization/workforce · 실행 기록 …/runs · 키 …/api-keys · 채용 = 에이전트 화면의 ?tab=recruit)', async () => {
    await mount();
    const href = (id: string) => container.querySelector(`[data-team-tab="${id}"]`)?.getAttribute('href');
    expect(href('agents')).toBe('/organization/workforce');
    expect(href('people')).toBe('/organization/members');
    expect(href('runs')).toBe('/organization/workforce/runs');
    expect(href('keys')).toBe('/organization/workforce/api-keys');
    expect(href('recruit')).toBe('/organization/workforce?tab=recruit');
  });

  it('⭐«지금 여기»: 화면마다 탭 하나만 켜진다(사이드바 · 막대와 같은 판정)', async () => {
    const cases: Array<[string, string, string]> = [
      ['/organization/workforce', '', 'agents'],
      ['/organization/workforce', 'tab=stats', 'agents'],
      ['/organization/workforce', 'tab=manage', 'agents'],
      ['/organization/workforce', 'tab=recruit', 'recruit'],
      ['/organization/workforce/0010f90a-d765', '', 'agents'],
      ['/organization/workforce/runs', '', 'runs'],
      ['/organization/workforce/api-keys', '', 'keys'],
      ['/organization/members', '', 'people'],
    ];
    for (const [path, query, want] of cases) {
      pathnameRef.current = path; queryRef.current = query;
      await mount();
      expect(current(), `${path}?${query}`).toEqual([want]);
      await act(async () => { root.unmount(); });
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
  });

  it('줄에 접근 이름(팀)이 있다', async () => {
    await mount();
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('팀');
  });
});

// ④ 두 화면 묶음의 레이아웃이 줄을 싣는다(구성원 화면 + 에이전트 화면들 — 라우트는 그대로).
describe('레이아웃이 «팀» 탭줄을 싣는다', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../app/(authenticated)/organization', rel), 'utf8');
  for (const dir of ['workforce', 'members']) {
    it(`organization/${dir}/layout.tsx`, () => {
      const src = read(`${dir}/layout.tsx`);
      expect(src).toContain("from '@/components/team/team-tabs'");
      expect(src).toContain('<TeamTabs />');
      expect(src).toContain('{children}');
    });
  }
});
