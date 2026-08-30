// @vitest-environment jsdom
//
// story #3231 2라운드(전수 스윕 자체 발견) — 이 섹션이 role 무관하게 email 포함 전체
// org 로스터를 렌더했다(canManage는 토글 버튼만 가리고 목록 자체는 안 가림). roles·
// members·settings「org-members」탭 3화면과 같은 "관리 화면=전 로스터 열람" 성격이라
// 동일 패턴(canManage 전면 게이트)으로 막는다 — BE org-members 자체가 admin/owner
// 전용 403이라 여기서도 fetch를 아예 안 쏘는지·안내 문구가 뜨는지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectAccessSection } from './project-access-section';

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
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ProjectAccessSection — Member 신분엔 관리자 전용 안내(story #3231)', () => {
  it('member — 안내 문구만 뜨고 email 포함 로스터 fetch 자체를 안 쏜다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<ProjectAccessSection projectId="proj-1" currentRole="member" />); });
    await flush();

    expect(container.textContent).toContain('관리자 전용 페이지입니다');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin — 무회귀, 기존처럼 접근 권한 목록이 정상 렌더된다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-1', name: '오너 하나', email: 'owner@moonklabs.com', role: 'owner' }] }) };
      }
      if (url === '/api/projects/proj-1/access') return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<ProjectAccessSection projectId="proj-1" currentRole="admin" />); });
    await flush();

    expect(container.textContent).not.toContain('관리자 전용 페이지입니다');
    expect(container.textContent).toContain('오너 하나');
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/org-members')).toBe(true);
  });
});
