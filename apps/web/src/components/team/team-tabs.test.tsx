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

const { pathnameRef, queryRef, ctxRef } = vi.hoisted(() => ({ pathnameRef: { current: '/organization/workforce' }, queryRef: { current: '' }, ctxRef: { current: {} as { projectId?: string; inShell?: boolean } } }));
// 프로젝트가 정해진 셸 안이면 flat 링크가 `?p=`를 싣는다(use-flat-href) — 그 문맥을 시험에서 켜고 끈다.
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctxRef.current }));
// story 4889 — «접근권한» 탭은 조직 관리자에게만: 역할 답을 시험이 정한다(use-org-admin의 조직별 답 규칙은 agents-page-tabs.role-org.4891.test.tsx가 지킨다).
const { adminRef } = vi.hoisted(() => ({ adminRef: { current: { isAdmin: true, loaded: true } } }));
vi.mock('@/hooks/use-org-admin', () => ({ useOrgAdmin: () => adminRef.current }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(queryRef.current),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
const { TeamTabs } = await import('./team-tabs');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { pathnameRef.current = '/organization/workforce'; queryRef.current = ''; ctxRef.current = {}; adminRef.current = { isAdmin: true, loaded: true }; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function mount(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><TeamTabs /></NextIntlClientProvider>);
  });
}
const tabs = () => [...container.querySelectorAll('[data-team-tab]')];
const current = () => tabs().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('data-team-tab'));

describe('«팀» 탭줄', () => {
  it('⭐순서와 이름(관리자): 에이전트 · 구성원 · 실행 기록 · API 키 · 채용 · 통계 · 접근 권한 — 가는 화면이 이미 쓰는 낱말 그대로(ko) · 이미 쓰던 다섯이 앞(story 4889 · PO 11-10)', async () => {
    await mount('ko');
    expect(tabs().map((a) => a.getAttribute('data-team-tab'))).toEqual(['agents', 'people', 'runs', 'keys', 'recruit', 'stats', 'access']);
    expect(tabs().map((a) => a.textContent)).toEqual(['에이전트', '구성원', '실행 기록', 'API 키', '채용', '통계', '접근 권한']);
    expect(tabs().map((a) => a.textContent)).toEqual([koMessages.nav.workforce, koMessages.nav.orgMembers, koMessages.nav.workforceRuns, koMessages.nav.workforceApiKeys, koMessages.agents.recruitTab, koMessages.agents.statsTab, koMessages.agents.accessTab]);
  });

  it('⭐일반 구성원에겐 «접근 권한»이 없다(다른 탭 자리는 하나도 안 밀린다) · 역할 답이 오기 전에도 없다', async () => {
    adminRef.current = { isAdmin: false, loaded: true };
    await mount('ko');
    expect(tabs().map((a) => a.getAttribute('data-team-tab'))).toEqual(['agents', 'people', 'runs', 'keys', 'recruit', 'stats']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    adminRef.current = { isAdmin: false, loaded: false };
    await mount('ko');
    expect(tabs().map((a) => a.getAttribute('data-team-tab'))).not.toContain('access');
  });

  it('en 이름도 같은 키에서 나온다', async () => {
    await mount('en');
    expect(tabs().map((a) => a.textContent)).toEqual([enMessages.nav.workforce, enMessages.nav.orgMembers, enMessages.nav.workforceRuns, enMessages.nav.workforceApiKeys, enMessages.agents.recruitTab, enMessages.agents.statsTab, enMessages.agents.accessTab]);
  });

  it('⭐탭은 진짜 페이지 이동 링크 — 라우트 이동 0(구성원 /organization/members · 에이전트 /organization/workforce · 실행 기록 …/runs · 키 …/api-keys · 채용 = 에이전트 화면의 ?tab=recruit)', async () => {
    await mount();
    const href = (id: string) => container.querySelector(`[data-team-tab="${id}"]`)?.getAttribute('href');
    expect(href('agents')).toBe('/organization/workforce');
    expect(href('people')).toBe('/organization/members');
    expect(href('runs')).toBe('/organization/workforce/runs');
    expect(href('keys')).toBe('/organization/workforce/api-keys');
    expect(href('recruit')).toBe('/organization/workforce?tab=recruit');
    expect(href('stats')).toBe('/organization/workforce?tab=stats');
    expect(href('access')).toBe('/organization/workforce?tab=access');
  });

  it('⭐«지금 여기»: 화면마다 탭 하나만 켜진다(사이드바 · 막대와 같은 판정)', async () => {
    const cases: Array<[string, string, string]> = [
      ['/organization/workforce', '', 'agents'],
      // story 4889 — 옛 `?tab=manage`(안쪽 «관리» 탭 · 북마크 · 알림 링크 · 문서 속 주소)는 «에이전트»로 열린다 — 되돌리면(예: manage를 따로 탭으로) 빨갛다
      ['/organization/workforce', 'tab=manage', 'agents'],
      ['/organization/workforce', 'tab=manage&p=proj-1', 'agents'],
      ['/organization/workforce', 'tab=stats', 'stats'],
      ['/organization/workforce', 'tab=access', 'access'],
      ['/organization/workforce', 'tab=bogus', 'agents'],
      ['/organization/workforce', 'p=proj-1', 'agents'],
      ['/organization/workforce', 'tab=recruit&p=proj-1', 'recruit'],
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

  it('⭐일반 구성원이 ?tab=access로 와도(관리자 전용 패널) 화면이 통계로 읽히듯 줄도 «통계»를 켠다 — 역할 답이 오기 전엔 건드리지 않는다', async () => {
    queryRef.current = 'tab=access';
    adminRef.current = { isAdmin: false, loaded: true };
    await mount();
    expect(current()).toEqual(['stats']);
    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    adminRef.current = { isAdmin: false, loaded: false };
    await mount();
    expect(current()).toEqual(['agents']); // 답 前: 접근 권한 탭 없음 · 줄은 «에이전트»(주소의 탭 값이 줄에 없으니)
  });

  it('⭐프로젝트가 정해진 셸 안: 링크가 ?p=를 싣고(채용은 ?tab=recruit&p=) 그래도 «지금 여기»는 그대로', async () => {
    ctxRef.current = { projectId: 'proj-1', inShell: true };
    queryRef.current = 'tab=recruit&p=proj-1';
    await mount();
    const href = (id: string) => container.querySelector(`[data-team-tab="${id}"]`)?.getAttribute('href');
    expect(href('agents')).toBe('/organization/workforce?p=proj-1');
    expect(href('people')).toBe('/organization/members?p=proj-1');
    expect(href('recruit')).toBe('/organization/workforce?tab=recruit&p=proj-1');
    expect(current()).toEqual(['recruit']);
  });

  // story #4885 — 줄은 ds TabNav(UI-3 5545)로 짓는다: 손코딩 줄을 되돌리면 RED.
  it('⭐줄은 ds TabNav · 탭은 ds TabNavLink — 켜진 탭만 aria-current=page 밑줄 문법(ds action 밑줄)', async () => {
    queryRef.current = 'tab=recruit';
    await mount();
    expect(container.querySelector('[data-slot="ds-tab-nav"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="ds-tab-nav-rule"]')).not.toBeNull();
    const links = [...container.querySelectorAll('[data-slot="ds-tab-nav-link"]')];
    expect(links.map((a) => a.getAttribute('data-team-tab'))).toEqual(['agents', 'people', 'runs', 'keys', 'recruit', 'stats', 'access']);
    const on = links.filter((a) => a.getAttribute('aria-current') === 'page');
    expect(on.map((a) => a.getAttribute('data-team-tab'))).toEqual(['recruit']);
    expect(on[0]!.className).toContain('border-ds-action');
    expect(links.filter((a) => a !== on[0]).every((a) => !a.className.includes('border-ds-action'))).toBe(true);
    // 옛 손코딩 줄의 색 문법은 남지 않는다
    expect(container.innerHTML).not.toContain('border-primary');
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
      expect(src.indexOf('<TeamTabs />'), '줄이 화면 위에').toBeLessThan(src.indexOf('{children}'));
    });
  }
});
