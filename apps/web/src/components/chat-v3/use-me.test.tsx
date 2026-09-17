// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMe } from './use-me';

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const { me, error } = useMe();
  return <span data-testid="probe">{error ? 'error' : me ? JSON.stringify(me) : 'loading'}</span>;
}

function readProbe(): string {
  return container.querySelector('[data-testid="probe"]')?.textContent ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mountProbe() {
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('useMe — /api/me 1콜', () => {
  it('⭐성공 — id/projectId/role을 반환한다', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'me-1', project_id: 'proj-1', role: 'owner' } }) });
    await mountProbe();
    expect(readProbe()).toBe(JSON.stringify({ id: 'me-1', projectId: 'proj-1', role: 'owner' }));
  });

  it('role이 owner/admin이 아니면 member로 낮춘다', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'me-1', project_id: 'proj-1', role: 'weird' } }) });
    await mountProbe();
    expect(readProbe()).toContain('"role":"member"');
  });

  // 페드루 PO CHANGES C2(2026-09-17 00:04Z, PR #4370) — 실패를 조용히 삼키면
  // 호출부가 "아직 로딩 중"과 구분 못 해 무한 로딩으로 보인다.
  it('⭐요청 실패(non-2xx) — error:true, me는 null', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mountProbe();
    expect(readProbe()).toBe('error');
  });

  it('⭐네트워크 예외 — error:true', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await mountProbe();
    expect(readProbe()).toBe('error');
  });

  it('응답에 id·project_id가 없으면 error:true(형상 불일치를 조용히 안 삼킨다)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    await mountProbe();
    expect(readProbe()).toBe('error');
  });
});
