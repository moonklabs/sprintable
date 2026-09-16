// @vitest-environment jsdom
//
// story #3953(블루프린트 §1-5) — 조직 전체 외부 발행 일시 중지 스위치 카드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args) }));

import { ExternalPublishPauseCard } from './external-publish-pause-card';

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
  mockFetchWithAuth.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => ({ data }) };
}

describe('ExternalPublishPauseCard', () => {
  it('활성 상태 — 정상 운영 문구만 뜨고 owner라도 「중지」 버튼과 사유 입력만(재개 버튼 없음)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-status-active"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).toBeNull();
  });

  it('⭐중지 상태 — 배너가 뜨고 사유가 있으면 문구에 실린다', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: '점검' }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    const banner = container.querySelector('[data-testid="external-publish-pause-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('점검');
  });

  it('중지 상태 — owner에게는 재개 버튼만(중지 버튼·사유 입력 없음)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).toBeNull();
  });

  it('음성대조 — admin(isOwnerStrict=false)은 상태만 보고 조작 버튼이 하나도 안 뜬다', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={false} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-status-active"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).toBeNull();
  });

  it('owner가 중지 버튼을 누르면 PUT paused=true로 호출한다', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: null }),
    );
    const button = container.querySelector('[data-testid="external-publish-pause-action"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const putCall = mockFetchWithAuth.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall![0]).toBe('/api/organizations/org-1/external-publish-pause');
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ paused: true, reason: null });
  });

  it('실패(PUT 4xx/5xx) — 에러 문구가 뜨고 상태는 그대로(낙관적 갱신 0)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: 'X' } }) });
    const button = container.querySelector('[data-testid="external-publish-pause-action"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="external-publish-pause-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-status-active"]')).not.toBeNull();
  });
});
