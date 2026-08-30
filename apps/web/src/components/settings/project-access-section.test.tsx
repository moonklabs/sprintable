// @vitest-environment jsdom
//
// story #3231 4라운드(카디르 QA) — 2라운드에서 이 섹션을 org-admin 전용(currentRole prop
// 기반)으로 잠갔는데, 실제 인가 경계는 org-admin이 아니라 "이 프로젝트의 effective
// 관리자"(org owner/admin 플로어 OR project-level owner/admin — additive, BE
// _require_owner_or_admin/has_project_role)였다 — org-admin은 아니지만 이 project의
// admin/owner인 org member가 새로 막혔던 신규 회귀. FE가 role을 별도로 재계산하지 않고
// project-access-candidates 응답(요청한 그 게이트를 서버가 통과시켰는지) 자체로 인가
// 여부를 판정하는지 검증한다.

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

describe('ProjectAccessSection — 인가는 서버 응답으로 판정(story #3231 4라운드)', () => {
  it('project-access-candidates가 403이면 안내 문구가 뜬다(org-admin이 아닌 진짜 미인가)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/projects/proj-1/access-candidates') return { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) };
      if (url === '/api/projects/proj-1/access') return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<ProjectAccessSection projectId="proj-1" />); });
    await flush();

    expect(container.textContent).toContain('관리자 전용 페이지입니다');
  });

  it('project-access-candidates가 200이면 org-admin이 아니어도(project-level admin) 정상 렌더된다 — 신규 회귀 pin', async () => {
    // 카디르 4라운드 정면 재현 — org-admin은 아니지만 project effective admin인 org
    // member가 이 화면을 실제로 관리할 수 있어야 한다. FE는 currentRole을 안 받으므로
    // (org-level role 자체를 모름) 서버가 200을 준 것 자체가 유일한 판정 근거다.
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/projects/proj-1/access-candidates') {
        return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-1', name: '프로젝트 관리자', email: 'padmin@moonklabs.com', role: 'member' }] }) };
      }
      if (url === '/api/projects/proj-1/access') return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<ProjectAccessSection projectId="proj-1" />); });
    await flush();

    expect(container.textContent).not.toContain('관리자 전용 페이지입니다');
    expect(container.textContent).toContain('프로젝트 관리자');
  });

  it('전용 candidates 엔드포인트를 호출한다(원 org-members roster 아님)', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/projects/proj-1/access-candidates') return { ok: true, json: async () => ({ data: [] }) };
      if (url === '/api/projects/proj-1/access') return { ok: true, json: async () => ({ data: [] }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(<ProjectAccessSection projectId="proj-1" />); });
    await flush();

    expect(calls).not.toContain('/api/org-members');
    expect(calls).toContain('/api/projects/proj-1/access-candidates');
  });
});
