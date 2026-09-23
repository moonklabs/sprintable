// @vitest-environment jsdom
//
// story #3953(블루프린트 §1-5) — 조직 전체 외부 발행 일시 중지 스위치 카드.
// 문구는 유나 §⑤ judgment(ec5d82b4-2106-4d29-83b2-afafbb7b393c) 정본 리터럴로 고정.
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
  it('⭐활성 상태(owner) — 정상 pill·owner 설명 문구·멈추기 버튼(재개 버튼 없음)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-status-pill"]')?.textContent).toBe('정상');
    expect(container.textContent).toContain('켜면 조직의 모든 외부 발행이 멈춰요. 소유자만 켤 수 있어요.');
    expect(container.querySelector('[data-testid="external-publish-pause-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).toBeNull();
  });

  it('⭐중지 상태(owner) — 멈춤 중 pill·배너 문구·재개 버튼(멈추기 버튼 없음)', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: '점검' }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-status-pill"]')?.textContent).toBe('멈춤 중');
    const banner = container.querySelector('[data-testid="external-publish-pause-banner"]');
    expect(banner?.textContent).toBe('외부 발행이 일시 중지됐어요 — 소유자가 풀면 다시 나가요. 승인·예약은 그대로예요.');
    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).toBeNull();
  });

  it('음성대조 — admin(isOwnerStrict=false)은 조작 버튼·사유 입력이 하나도 안 뜨고 소유자 전용 안내만', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={false} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('소유자만 바꿀 수 있어요.');
    expect(container.querySelector('[data-testid="external-publish-pause-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-resume-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-reason-input"]')).toBeNull();
  });

  it('사유 placeholder(멈추기 방향) — 오발행 확인 예시가 실린 정본 문구', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });
    const pauseInput = container.querySelector('[data-testid="external-publish-pause-reason-input"]') as HTMLInputElement;
    expect(pauseInput.placeholder).toBe('멈추는 이유를 한 줄로 적어 주세요 — 감사 로그에 남아요. (예: 오발행 확인 중·토큰 점검)');
  });

  it('사유 placeholder(풀기 방향) — 멈추기 방향과 다른 정본 문구', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });
    const resumeInput = container.querySelector('[data-testid="external-publish-resume-reason-input"]') as HTMLInputElement;
    expect(resumeInput.placeholder).toBe('푸는 이유를 적어 주세요 — 감사 로그에 남아요.');
  });

  it('owner가 사유를 적고 멈추기를 누르면 PUT paused=true·reason으로 호출한다', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    const input = container.querySelector('[data-testid="external-publish-pause-reason-input"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, '오발행 확인 중');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: '오발행 확인 중' }),
    );
    const button = container.querySelector('[data-testid="external-publish-pause-action"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const putCall = mockFetchWithAuth.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(putCall![0]).toBe('/api/organizations/org-1/external-publish-pause');
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ paused: true, reason: '오발행 확인 중' });
  });

  it('owner가 사유를 적고 풀기를 누르면 PUT paused=false·reason으로 호출한다(재개도 사유를 받는다)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: true, paused_at: '2026-09-17T00:00:00Z', paused_by: 'm1', reason: '점검' }),
    );
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    const input = container.querySelector('[data-testid="external-publish-resume-reason-input"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, '점검 끝');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    const button = container.querySelector('[data-testid="external-publish-resume-action"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const putCall = mockFetchWithAuth.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ paused: false, reason: '점검 끝' });
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
    expect(container.querySelector('[data-testid="external-publish-pause-status-pill"]')?.textContent).toBe('정상');
  });

  it('story #3953 CHANGES — 최초 GET 실패(404 등) 시 카드가 조용히 안 사라지고 로드-실패 문구+다시 시도가 뜬다', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-load-error"]')?.textContent).toBe(
      '상태를 불러오지 못했어요 — 다시 시도해 주세요.',
    );
    expect(container.querySelector('[data-testid="external-publish-pause-status-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-load-retry"]')).not.toBeNull();
  });

  it('story #3953 CHANGES(유나 design 리뷰) — 로드-실패 상태에서도 카드 제목이 보인다(채널 연결 상태로 오해되지 않도록)', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain('외부 발행 일시 중지');
  });

  it('story #3953 CHANGES(유나 design 리뷰) — 재시도 중엔 버튼이 disabled+aria-busy', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    let resolveRetry: (v: unknown) => void = () => {};
    mockFetchWithAuth.mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
    const retry = container.querySelector('[data-testid="external-publish-pause-load-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveRetry({ ok: false, json: async () => ({}) });
      await Promise.resolve();
    });
  });

  it('story #3953 CHANGES — GET 자체가 throw(네트워크 오류)해도 로드-실패 문구가 뜬다', async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('[data-testid="external-publish-pause-load-error"]')).not.toBeNull();
  });

  it('story #3953 CHANGES — 로드-실패 뒤 「다시 시도」를 누르면 재조회해 정상 카드로 전환된다', async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    await act(async () => {
      root.render(wrap(<ExternalPublishPauseCard orgId="org-1" isOwnerStrict={true} />));
    });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="external-publish-pause-load-error"]')).not.toBeNull();

    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ paused: false, paused_at: null, paused_by: null, reason: null }),
    );
    const retry = container.querySelector('[data-testid="external-publish-pause-load-retry"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="external-publish-pause-load-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="external-publish-pause-status-pill"]')?.textContent).toBe('정상');
  });
});
