// @vitest-environment jsdom
//
// story #4171(E-MOBILE-SPEED) — «인증 실패» 뱃지는 presence 패널 안에만 뜬다. 모바일 첫 화면(패널 =
// 닫힌 drawer)에선 my-actions를 부르지 않고, 패널이 열리는 순간 곧바로 부른다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fetchWithAuthMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...(a as [])) }));

import { useAgentAuthFailures } from './use-agent-auth-failures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); fetchWithAuthMock.mockClear(); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function Probe({ active }: { active: boolean }) { useAgentAuthFailures(active); return null; }

it('패널이 닫혀 있으면 my-actions 0회, 열리면 곧바로 1회', async () => {
  await act(async () => { root.render(<Probe active={false} />); });
  expect(fetchWithAuthMock).not.toHaveBeenCalled();
  await act(async () => { root.render(<Probe active />); });
  expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/dashboard/my-actions');
});

it('셸은 상수 true가 아니라 패널이 보이는지로 켠다', () => {
  const src = readFileSync(join(__dirname, '../../app/dashboard/dashboard-shell.tsx'), 'utf8');
  expect(src).toContain('useAgentAuthFailures(panelVisible)');
  expect(src).toContain('const panelVisible = panel.inlinePanelOpen || panel.drawerOpen;');
  expect(src).not.toContain('useAgentAuthFailures(true)');
});
