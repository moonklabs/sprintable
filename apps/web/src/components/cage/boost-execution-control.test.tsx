// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BoostExecutionControl } from './boost-execution-control';
import { fetchWithAuth } from '@/lib/db/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

const mockedFetch = vi.mocked(fetchWithAuth);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockedFetch.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as Response;
}

const SEALED = {
  sealedAdsBudgetMinor: 50_000, sealedAdsCurrency: 'KRW',
  sealedAdsStartsAt: '', sealedAdsEndsAt: '2026-09-19T00:00:00Z', sealedAdsObjective: 'POST_ENGAGEMENT',
};

describe('BoostExecutionControl — story #3806(Phase3·3-2 PR5, 유나 §절 §2·페드루 PO 콜① 시작 지름길)', () => {
  it('⭐run_status="running" — 「실행 중」 표시 + 「중지」 버튼만 뜬다(재개·시작 버튼 0)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-execution-control"]')?.textContent)
      .toContain(koMessages.cage.boostExecutionStatusRunning);
    expect(document.body.querySelector('[data-testid="boost-pause-trigger"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="boost-resume-trigger"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="boost-start-trigger"]')).toBeNull();
  });

  // story #3806 PR 9②(PR8 #4185, 페드루 PO 確定 2026-09-11) — /spend가 신규
  // initiated_by를 실으면 「시작: ...」 한 줄이 뜬다. PR8 착지 前엔 이 필드가
  // 응답에 없어(undefined) 항상 숨어야 한다 — falsy-safe 회귀 가드.
  it('⭐initiated_by="human" — 「시작: 사람 클릭」이 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running', initiated_by: 'human' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-execution-initiated-by"]')?.textContent)
      .toBe(koMessages.cage.boostExecutionInitiatedByHuman);
  });

  it('⭐initiated_by="scheduler" — 「시작: 예약 실행(자동) {date}」가 봉인 starts_at으로 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running', initiated_by: 'scheduler' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T09:00:00Z" />,
      ));
    });
    await flush();

    const text = document.body.querySelector('[data-testid="boost-execution-initiated-by"]')?.textContent ?? '';
    expect(text).toContain('예약 실행(자동)');
    expect(text).toContain('09-01');
    expect(text).not.toContain('사람 클릭');
  });

  it('initiated_by가 응답에 없으면(PR8 미착지·구 데이터) 「시작: ...」 줄 자체가 안 뜬다(falsy-safe)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-execution-initiated-by"]')).toBeNull();
  });

  it('⭐run_status="paused" — 「중지됨」 표시 + 「재개」 버튼만 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'paused' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-execution-control"]')?.textContent)
      .toContain(koMessages.cage.boostExecutionStatusPaused);
    expect(document.body.querySelector('[data-testid="boost-resume-trigger"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="boost-pause-trigger"]')).toBeNull();
  });

  it('⭐「중지」 클릭 → 확認 다이얼로그에 유나 §절 원문 그대로 뜬다("홍보를 중지하면 이후 광고비가 발생하지 않습니다")', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    const trigger = document.body.querySelector('[data-testid="boost-pause-trigger"]') as HTMLButtonElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(document.body.querySelector('[data-testid="boost-pause-confirm-dialog"]')?.textContent)
      .toContain('홍보를 중지하면 이후 광고비가 발생하지 않습니다');
  });

  it('⭐확認 클릭 → POST .../pause 호출 뒤 재조회로 「중지됨」으로 전환된다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
      ));
    });
    await flush();

    const trigger = document.body.querySelector('[data-testid="boost-pause-trigger"]') as HTMLButtonElement;
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { command_id: 'cmd-1', operation: 'pause', toggle_seq: 1, status: 'pending' } }, 201));
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'paused' } }));

    const confirm = document.body.querySelector('[data-testid="boost-pause-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(mockedFetch.mock.calls[1][0]).toBe('/api/organizations/org-1/ads-boosts/gate-1/pause');
    expect((mockedFetch.mock.calls[1][1] as RequestInit).method).toBe('POST');
    expect(document.body.querySelector('[data-testid="boost-execution-control"]')?.textContent)
      .toContain(koMessages.cage.boostExecutionStatusPaused);
  });

  it('⭐run_status=null·starts_at 미래 — 「홍보 시작」 버튼 비활성 + 시작일 전 사유 문구', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: null } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2099-01-01T00:00:00Z" />,
      ));
    });
    await flush();

    const startBtn = document.body.querySelector('[data-testid="boost-start-trigger"]') as HTMLButtonElement;
    expect(startBtn).not.toBeNull();
    expect(startBtn.disabled).toBe(true);
    expect(document.body.querySelector('[data-testid="boost-start-before-schedule"]')).not.toBeNull();
  });

  it('⭐run_status=null·starts_at 과거 — 「홍보 시작」 활성 → 클릭 시 봉인 3값이 확認 다이얼로그에 뜬다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: null } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2020-01-01T00:00:00Z" />,
      ));
    });
    await flush();

    const startBtn = document.body.querySelector('[data-testid="boost-start-trigger"]') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    await act(async () => { startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const dialogText = document.body.querySelector('[data-testid="boost-start-confirm-dialog"]')?.textContent ?? '';
    // story #3806(정정1, 페드루 PO 리뷰 2026-09-11 13:00Z) — 원시 enum이 아니라 사람
    // 낱말(유나 §절 낱말표)로 떠야 한다.
    expect(dialogText).toContain('참여');
    expect(dialogText).not.toContain('POST_ENGAGEMENT');
    expect(dialogText).toContain('50,000원');
  });

  it('⭐시작 확認 → POST .../start 호출된다', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: null } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2020-01-01T00:00:00Z" />,
      ));
    });
    await flush();
    const startBtn = document.body.querySelector('[data-testid="boost-start-trigger"]') as HTMLButtonElement;
    await act(async () => { startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { command_id: 'cmd-2', operation: 'boost_start', toggle_seq: 0, status: 'pending' } }, 201));
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));

    const confirm = document.body.querySelector('[data-testid="boost-start-confirm"]') as HTMLButtonElement;
    await act(async () => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(mockedFetch.mock.calls[1][0]).toBe('/api/organizations/org-1/ads-boosts/gate-1/start');
  });

  it('run_status=null·starts_at 없음(그라운딩 갭) — 아무것도 안 그린다(지어내지 않는다)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: null } }));
    await act(async () => {
      root.render(wrap(
        <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt={null} />,
      ));
    });
    await flush();

    expect(document.body.querySelector('[data-testid="boost-execution-control"]')).toBeNull();
  });

  // story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 「광고비 다시
  // 수집」 버튼. comments/refresh 동형 UX(429 rate-limit 문구).
  describe('「광고비 다시 수집」(PR 12)', () => {
    it('⭐run_status="running"이면 버튼이 뜨고, 클릭 → 올바른 엔드포인트 호출+성공 시 재조회', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
        ));
      });
      await flush();

      const btn = document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe(koMessages.cage.boostExecutionSpendRefresh);

      mockedFetch.mockResolvedValueOnce(
        jsonResponse({ data: { spend_minor: 12345, captured_at: '2026-09-11T17:30:00Z', cap_reached: false, run_status: 'running' } }, 201),
      );
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));

      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(mockedFetch.mock.calls[1][0]).toBe('/api/organizations/org-1/ads-boosts/gate-1/spend/refresh');
      expect(document.body.querySelector('[data-testid="boost-spend-refresh-error"]')).toBeNull();
      // story #3806(PR 12, 페드루 PO 실측 캡처 2026-09-11 18:16Z) — 「눌렀는데 아무
      // 일도 없었다」 결함 재발 방지: 성공 응답값이 화면에 그대로 보여야 한다.
      expect(document.body.querySelector('[data-testid="boost-spend-refresh-success"]')?.textContent)
        .toContain('12,345');
    });

    it('성공 시 onSpendRefreshed 콜백을 호출한다(형제 GateActivityHistory 재조회 트리거)', async () => {
      const onSpendRefreshed = vi.fn();
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl
            orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z"
            onSpendRefreshed={onSpendRefreshed}
          />,
        ));
      });
      await flush();

      mockedFetch.mockResolvedValueOnce(
        jsonResponse({ data: { spend_minor: 12345, captured_at: '2026-09-11T17:30:00Z', cap_reached: false, run_status: 'running' } }, 201),
      );
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));

      const btn = document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]') as HTMLButtonElement;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(onSpendRefreshed).toHaveBeenCalledOnce();
    });

    it('429(초 있음) — 버튼 밖에 "{N}초 뒤 다시 시도할 수 있습니다." 문구', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
        ));
      });
      await flush();

      mockedFetch.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'ADS_SPEND_REFRESH_RATE_LIMITED' } }, 429, { 'Retry-After': '240' }),
      );
      const btn = document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]') as HTMLButtonElement;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(document.body.querySelector('[data-testid="boost-spend-refresh-error"]')?.textContent).toBe('240초 뒤 다시 시도할 수 있습니다.');
    });

    it('429(Retry-After 헤더 없음) — 초를 지어내지 않고 "잠시 뒤" 문구로 물러난다', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
        ));
      });
      await flush();

      mockedFetch.mockResolvedValueOnce(jsonResponse({ error: { code: 'ADS_SPEND_REFRESH_RATE_LIMITED' } }, 429));
      const btn = document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]') as HTMLButtonElement;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(document.body.querySelector('[data-testid="boost-spend-refresh-error"]')?.textContent).toBe('잠시 뒤 다시 시도할 수 있습니다.');
    });

    it('409(ADS_BOOST_NOT_STARTED 등 generic) — 공용 에러 문구', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'running' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
        ));
      });
      await flush();

      mockedFetch.mockResolvedValueOnce(jsonResponse({ error: { code: 'ADS_BOOST_NOT_STARTED' } }, 409));
      const btn = document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]') as HTMLButtonElement;
      await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush();

      expect(document.body.querySelector('[data-testid="boost-spend-refresh-error"]')?.textContent).toBe(koMessages.cage.boostExecutionActionError);
    });

    it('run_status="paused"에서도 버튼이 뜬다(중지 상태에서도 최근 지출은 확인 가능)', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse({ data: { run_status: 'paused' } }));
      await act(async () => {
        root.render(wrap(
          <BoostExecutionControl orgId="org-1" gateId="gate-1" {...SEALED} sealedAdsStartsAt="2026-09-01T00:00:00Z" />,
        ));
      });
      await flush();

      expect(document.body.querySelector('[data-testid="boost-spend-refresh-trigger"]')).not.toBeNull();
    });
  });
});
