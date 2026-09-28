// @vitest-environment jsdom
// [SID:4311 PR 3] 가설 행의 담당(@) — 같은 이름 서로 다른 담당 둘이면 «· ID 앞 8자»(담당 id마다 한 번) · 다른 이름은 꼬리 없음.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentTeamMemberId: 'me-1' }) }));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { HypothesesSection } from './hypotheses-section';
import { ORG_NAMES_URL } from '@/hooks/use-member-name-fallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); fetchWithAuthMock.mockReset(); });

function hypothesis(id: string, owner: string): Hypothesis {
  return {
    id, org_id: 'org-1', project_id: 'proj-1', owner_member_id: owner, created_by_member_id: null, confirmed_by_member_id: null,
    statement: `가설 ${id}`, metric_definition: { metric: 'activation', target: 10, direction: 'up' } as never, measure_after: '2026-08-01T00:00:00Z',
    status: 'active', outcome_result: null, confidence: null, source_type: null, source_id: null, human_accounting: {}, gate_contract: {},
    epic_ids: [], story_ids: [], created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  } as Hypothesis;
}

describe('HypothesesSection — 담당 동명이인([SID:4311 PR 3])', () => {
  it('«송윤재» 둘 = 행마다 @이름 · id 앞 8자 · 같은 사람 두 행 = 같은 꼬리 · 안나 = 꼬리 없음', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/hypotheses?')) {
        return { ok: true, json: async () => ({ data: [hypothesis('h1', 'e75ca548-1'), hypothesis('h2', '2fd14616-2'), hypothesis('h3', 'm-anna'), hypothesis('h4', 'e75ca548-1')] }) };
      }
      if (url === ORG_NAMES_URL) {
        return { ok: true, json: async () => ({ data: [{ id: 'e75ca548-1', name: '송윤재' }, { id: '2fd14616-2', name: '송윤재' }, { id: 'm-anna', name: '안나' }] }) };
      }
      return { ok: true, json: async () => [] };
    });
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><HypothesesSection epicId="e1" projectId="proj-1" /></NextIntlClientProvider>);
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    const owners = [...container.querySelectorAll('span')].map((el) => el.textContent ?? '').filter((txt) => txt.startsWith('@'));
    expect(owners).toEqual(['@송윤재 · e75ca548', '@송윤재 · 2fd14616', '@안나', '@송윤재 · e75ca548']);
  });
});
