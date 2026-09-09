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

// 실 nav-config.ts의 23항목/7구역과 다른 수(2구역·3항목)로 교체 — 부제가 이 가짜 값을
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
}));

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

describe('MorePage 부제 — SSOT를 바꾸면 부제도 따라 움직인다(story #fddd0e6b AC1, 하드코딩 0 증명)', () => {
  it('⭐가짜 카탈로그(2구역·3항목)로 모킹하면 부제가 「21개 화면 · 7개 구역」이 아니라 「3개 화면 · 2개 구역」이다', async () => {
    const { default: MorePage } = await import('./page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => { root.render(wrap(<TopBarProvider><MorePage /></TopBarProvider>)); });
    const subtitle = container.querySelector('[data-testid="more-subtitle"]');
    expect(subtitle?.textContent).toBe('3개 화면 · 2개 구역');
  });
});
