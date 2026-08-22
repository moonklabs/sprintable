// @vitest-environment jsdom
//
// story #2923(카디르 QA HIGH1·HIGH2, PR#3352 2026-08-22 처방) — HIGH1: /api/inbox 호출에
// project_id가 실려 다른 프로젝트 항목이 안 새어나오는지. HIGH2: 같은 story의 gate_pending
// (BE)과 approval(inbox)이 동시에 오면 한 행으로만 뜨는지(Gate 우선, inbox 쪽 drop).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const { AttentionQueueView } = await import('./attention-queue-view');
  await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('AttentionQueueView — HIGH1 project_id 필터(story #2923, 카디르 QA)', () => {
  it('/api/inbox 호출 URL에 project_id가 실린다(BE attention fetch와 동형)', async () => {
    const calledUrls: string[] = [];
    await mount(async (url: string) => {
      calledUrls.push(url);
      return { ok: true, json: async () => ({ data: { items: [] } }) };
    });
    const inboxCall = calledUrls.find((u) => u.includes('/api/inbox'));
    expect(inboxCall).toContain('project_id=proj-1');
  });
});

describe('AttentionQueueView — HIGH2 cross-source dedup(story #2923, 카디르 QA)', () => {
  it('같은 story의 gate_pending(BE)과 approval(inbox)이 동시에 오면 한 행만 뜬다(Gate 우선)', async () => {
    await mount(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return {
          ok: true,
          json: async () => ({
            data: { items: [{ kind: 'gate_pending', story_id: 's1', title: '가격 콘솔', ref: {}, entered_state_at: null }] },
          }),
        };
      }
      if (url.includes('/api/inbox')) {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: 'inbox-a1', kind: 'approval', title: '가격 콘솔 결재 요청(중복)',
              origin_chain: [{ type: 'story', id: 's1' }], created_at: '2026-08-22T00:00:00.000Z',
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    });
    // 중복 inbox 항목의 claim 텍스트는 안 뜨고(drop됨), BE gate_pending 쪽 claim만 남는다.
    expect(container.textContent).not.toContain('가격 콘솔 결재 요청(중복)');
    expect(container.textContent).toContain('가격 콘솔');
  });

  it('다른 story의 approval은 gate_pending과 안 겹치므로 둘 다 뜬다(과잉 dedup 아님)', async () => {
    await mount(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return {
          ok: true,
          json: async () => ({
            data: { items: [{ kind: 'gate_pending', story_id: 's1', title: '가격 콘솔', ref: {}, entered_state_at: null }] },
          }),
        };
      }
      if (url.includes('/api/inbox')) {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: 'inbox-a1', kind: 'approval', title: '법적고지 결재 요청',
              origin_chain: [{ type: 'story', id: 's2' }], created_at: '2026-08-22T00:00:00.000Z',
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    });
    expect(container.textContent).toContain('법적고지 결재 요청');
    expect(container.textContent).toContain('가격 콘솔');
  });
});
