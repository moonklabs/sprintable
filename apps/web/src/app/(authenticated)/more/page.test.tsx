// @vitest-environment jsdom
//
// story #2682(모바일 IA S2) — 「전체」(/more)를 평면 stub에서 데스크톱 GNB(nav-config.ts)
// 미러 그룹형 허브로 재건한 회귀가드. AC1(org 그룹·조직브리핑 포함)·AC3(아코디언 없음·stub
// 배너 제거)·중복 방지(flow/inbox/chats는 바텀 탭이 이미 depth 1로 커버)를 실 렌더로 잰다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode, Provider: React.ComponentType<{ children: React.ReactNode }>) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <Provider>{node}</Provider>
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

async function mount() {
  const { default: MorePage } = await import('./page');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  await act(async () => { root.render(wrap(<MorePage />, TopBarProvider)); });
}

describe('MorePage — story #2682 GNB 미러 그룹형 허브(AC1·AC3)', () => {
  // story #2930(P0-G) I1 — zoneNow/zoneWork 텍스트가 "오늘"/"워크스페이스"로 개명(시안
  // ia-4zone-redesign-2930 그대로). 순서 자체(오늘→워크스페이스→신뢰→지식→조직→설정)는
  // MOBILE_HUB_GROUP_ORDER 무변화 — 데스크톱이 이 순서를 따라잡았을 뿐, 모바일은 원래도 이
  // 순서였다(더 이상 "데스크톱과 다른 순서"가 아니다, app-sidebar.test.tsx도 동일 순서로 갱신).
  it('섹션 순서가 doc §2.3 그대로다(오늘/워크스페이스/신뢰/지식/조직/설정)', async () => {
    await mount();
    const sectionLabels = [...container.querySelectorAll('h2')].map((el) => el.textContent);
    expect(sectionLabels).toEqual(['오늘', '워크스페이스', '신뢰', '지식', '조직', '설정']);
  });

  it('조직 그룹(이벤트 포함)과 조직브리핑이 포함된다(AC1 — 기존 stub의 핵심 결함 수복)', async () => {
    await mount();
    expect(container.textContent).toContain('이벤트');
    expect(container.textContent).toContain('구성원');
    expect(container.textContent).toContain('워크포스');
    expect(container.textContent).toContain('조직 브리핑');
  });

  it('flow·inbox·chats는 안 뜬다(바텀 탭이 이미 depth 1로 커버 — 중복 진입점 방지)', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    expect(links.some((a) => a.getAttribute('href') === '/flow')).toBe(false);
    expect(links.some((a) => a.getAttribute('href') === '/inbox')).toBe(false);
    expect(links.some((a) => a.getAttribute('href') === '/chats')).toBe(false);
  });

  it('임시 stub 배너가 제거됐다(AC3)', async () => {
    await mount();
    expect(container.textContent).not.toContain('임시 목록');
  });

  it('아코디언이 아니다 — 전 섹션의 링크가 펼침 조작 없이 DOM에 항상 존재한다(AC3)', async () => {
    await mount();
    // <button aria-expanded>류 접이식 컨트롤이 그룹 헤더에 없다 — h2는 순수 텍스트.
    const toggles = [...container.querySelectorAll('[aria-expanded]')];
    expect(toggles.length).toBe(0);
    // 이벤트(조직 그룹, 목록 순서상 뒤쪽 섹션)가 별도 조작 없이 이미 렌더돼 있다.
    const eventsLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('이벤트'));
    expect(eventsLink?.getAttribute('href')).toBe('/organization/events');
  });

  it('정적 항목은 절대경로, resource 항목은 bare 폴백 href를 쓴다(리팩터 전 규약 보존)', async () => {
    await mount();
    const links = [...container.querySelectorAll('a')];
    const membersLink = links.find((a) => a.textContent?.includes('구성원'));
    expect(membersLink?.getAttribute('href')).toBe('/organization/members');
    // story #2930 I3 — '스프린트'는 nav-config work 존에서 '보드'로 접혀 빠졌다(href는 옛
    // 흐름의 '/flow' 그대로 보존). resource 폴백 규약 자체를 확認하는 게 목적이라 대체 항목으로.
    const goalsLink = links.find((a) => a.textContent?.includes('목표'));
    expect(goalsLink?.getAttribute('href')).toBe('/goals');
  });

  it('doc a0da40c9 §21-1(2026-09-05) — 조직 그룹에 새로 추가된 「성과 보드」가 이 모바일 허브에도 뜬다(하나만 서면 모바일 진입점이 아예 없다는 규율의 회귀가드)', async () => {
    await mount();
    const insightsBoardLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('성과 보드'));
    expect(insightsBoardLink?.getAttribute('href')).toBe('/organization/insights-board');
  });

  it('설정 섹션이 그룹 라벨로 뜬다(desktop 무라벨 footer와 달리 허브에선 명시 섹션)', async () => {
    await mount();
    const settingsSection = [...container.querySelectorAll('h2')].find((h) => h.textContent === '설정');
    expect(settingsSection).toBeDefined();
    const settingsLink = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings');
    expect(settingsLink).toBeDefined();
  });
});
