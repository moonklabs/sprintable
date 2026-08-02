// @vitest-environment jsdom
//
// story #2357 — 기각한 관계 목록 + 되살리기 왕복 검증. AC4(빈 목록은 안 그린다)·AC6("다시
// 후보로 올라올 수 있습니다" 사실 진술, 시점 약속 없음)·토스트 없이 그 행 자리에 결과가
// 남는 것(㉣)까지 값으로 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { RejectedRelationsSection } from './rejected-relations-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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
  vi.restoreAllMocks();
});

async function render(storyId: string) {
  await act(async () => {
    root.render(withIntl(<RejectedRelationsSection storyId={storyId} />));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

describe('RejectedRelationsSection — AC4(빈 목록은 안 그린다)', () => {
  it('renders nothing when the story has rejected no relations', async () => {
    stubFetch(() => ({ ok: true, json: async () => [] }) as Response);
    await render('s1');
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on fetch failure (fails quiet, not a broken empty box)', async () => {
    stubFetch(() => ({ ok: false, json: async () => null }) as Response);
    await render('s1');
    expect(container.innerHTML).toBe('');
  });
});

describe('RejectedRelationsSection — 목록 렌더 + 제목 조회', () => {
  it('lists a rejected relation with its target story title', async () => {
    stubFetch((url) => {
      if (url.includes('/rejected-relations')) {
        return {
          ok: true,
          json: async () => [{ id: 'rr1', target_type: 'story', target_id: 't1', reason: null, rejected_by: 'm1', rejected_at: '2020-01-01T00:00:00Z' }],
        } as Response;
      }
      if (url.includes('/api/stories/t1')) {
        return { ok: true, json: async () => ({ data: { title: '옛 후보 스토리' } }) } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    });
    await render('s1');
    expect(container.textContent).toContain('옛 후보 스토리');
    expect(container.textContent).toContain('기각한 관계 1건');
  });

  it('shows a neutral fallback when the target title lookup fails (target gone, not hidden)', async () => {
    stubFetch((url) => {
      if (url.includes('/rejected-relations')) {
        return {
          ok: true,
          json: async () => [{ id: 'rr1', target_type: 'story', target_id: 't1', reason: null, rejected_by: null, rejected_at: '2020-01-01T00:00:00Z' }],
        } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    });
    await render('s1');
    expect(container.textContent).toContain('대상이 없습니다');
  });
});

describe('RejectedRelationsSection — 되살리기(restore) 왕복', () => {
  it('clicking [되살리기] calls DELETE .../rejected-relations/{targetId} and shows the factual confirmation in place (no toast, stays in the row)', async () => {
    stubFetch((url, init) => {
      if (url.includes('/rejected-relations/t1') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/rejected-relations')) {
        return {
          ok: true,
          json: async () => [{ id: 'rr1', target_type: 'story', target_id: 't1', reason: null, rejected_by: null, rejected_at: '2020-01-01T00:00:00Z' }],
        } as Response;
      }
      if (url.includes('/api/stories/t1')) {
        return { ok: true, json: async () => ({ data: { title: '되살릴 스토리' } }) } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    });
    await render('s1');
    const restoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '되살리기')!;
    expect(restoreBtn).toBeTruthy();
    await act(async () => { restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // AC6 — "다음 스토리 저장에서 다시 후보로 오를 수 있습니다" 수준의 사실 진술이 그
    // 행 자리에 남는다(PO 지적 2026-08-02 — 되살리기가 candidate를 즉시 되살리지 않고
    // 다음 story 저장이 있어야 한다는 실제 BE 동작을 문구에 반영). 시점을 약속하는
    // 문구("곧 다시 뜹니다")가 아니라는 것도 같이 고정한다.
    expect(container.textContent).toContain('다음 스토리 저장에서 다시 후보로 오를 수 있습니다');
    expect(container.textContent).not.toContain('곧');
    // 되살린 뒤에도 목록/제목은 사라지지 않는다(토스트처럼 없어지지 않는다).
    expect(container.textContent).toContain('되살릴 스토리');
    expect(container.querySelectorAll('button').length).toBe(0); // 되살리기 버튼은 사실 문장으로 대체됨
  });

  it('on restore failure, shows the server error next to that row and keeps the restore button', async () => {
    stubFetch((url, init) => {
      if (url.includes('/rejected-relations/t1') && init?.method === 'DELETE') {
        return { ok: false, json: async () => ({ detail: 'Rejected relation not found' }) } as Response;
      }
      if (url.includes('/rejected-relations')) {
        return {
          ok: true,
          json: async () => [{ id: 'rr1', target_type: 'story', target_id: 't1', reason: null, rejected_by: null, rejected_at: '2020-01-01T00:00:00Z' }],
        } as Response;
      }
      if (url.includes('/api/stories/t1')) {
        return { ok: true, json: async () => ({ data: { title: '되살릴 스토리' } }) } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    });
    await render('s1');
    const restoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '되살리기')!;
    await act(async () => { restoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain('Rejected relation not found');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '되살리기')).toBe(true);
  });
});
