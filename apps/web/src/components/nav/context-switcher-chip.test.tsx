// @vitest-environment jsdom
//
// story #2076 — top-bar 좌상단 컨텍스트 칩(<1024). 현재 조직/프로젝트를 상시 표시하고 탭하면
// 전환 바텀시트가 열리는 것, 그리고 프로젝트 선택 시 useUnifiedSwitcher(사이드바와 동일 훅)의
// switchProject가 정확히 호출되는 것을 실제 DOM(createRoot)으로 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ContextSwitcherChip } from './context-switcher-chip';
import koMessages from '../../../messages/ko.json';

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/create-organization-dialog', () => ({
  CreateOrganizationDialog: () => null,
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

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [
  { projectId: 'proj-1', projectName: 'Sprintable' },
  { projectId: 'proj-2', projectName: 'Landing' },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  refreshMock.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ContextSwitcherChip — story #2076', () => {
  it('현재 조직›프로젝트를 라벨로 표시하고 lg:hidden(≥1024에서 숨김)이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toContain('뭉클랩');
    expect(trigger?.textContent).toContain('Sprintable');
    expect(trigger?.className).toContain('lg:hidden');
  });

  it('긴급 fix(채팅 리스트 재현) — max-w가 뷰포트 비례(vw)가 아닌 고정 px 캡이다', async () => {
    // max-w-[55vw]는 title+actions 있는 allowlist 화면(채팅·목표 등)에서 아이콘 클러스터와
    // 합쳐 <1024 뷰포트를 82px 초과했다(실측, 2076 회귀 후속) — 고정 px 캡으로 되돌아가는
    // 회귀를 막는다.
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    expect(trigger?.className).not.toMatch(/max-w-\[\d+vw\]/);
    expect(trigger?.className).toMatch(/max-w-\[\d+px\]/);
  });

  it('칩을 탭하기 전에는 프로젝트 목록(바텀시트 내용)이 안 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    expect(document.body.textContent).not.toContain('Landing');
  });

  it('칩을 탭하면 바텀시트가 열려 프로젝트 목록이 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain('Landing');
  });

  it('시트에서 다른 프로젝트를 선택하면 switchProject 경로(fetch /api/switch-project)가 호출된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const landingButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Landing'));
    await act(async () => {
      landingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/switch-project',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ project_id: 'proj-2' }) }),
    );
  });
});
