// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMyOrgRole } from './use-my-org-role';

const fetchMock = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const role = useMyOrgRole();
  return <span data-testid="probe-role">{role ?? ''}</span>;
}

function readCaptured(): string | null {
  const text = container.querySelector('[data-testid="probe-role"]')?.textContent ?? '';
  return text === '' ? null : text;
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

describe('useMyOrgRole — /api/me 1콜, fail-closed', () => {
  it('⭐role=owner면 그대로 owner', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { role: 'owner' } }) });
    await mountProbe();
    expect(readCaptured()).toBe('owner');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('⭐role=admin이면 admin', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { role: 'admin' } }) });
    await mountProbe();
    expect(readCaptured()).toBe('admin');
  });

  it('⭐role=member면 member', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { role: 'member' } }) });
    await mountProbe();
    expect(readCaptured()).toBe('member');
  });

  it('⭐요청 실패면 fail-closed로 member(admin-only 액션이 조용히 안 보이는 안전한 기본값)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await mountProbe();
    expect(readCaptured()).toBe('member');
  });

  it('⭐네트워크 예외도 fail-closed로 member', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await mountProbe();
    expect(readCaptured()).toBe('member');
  });
});
