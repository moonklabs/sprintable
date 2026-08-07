// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { BillingTab, UpgradeCheckoutDialog } from './billing-tab';

const replaceMock = vi.fn();
let searchParams = new URLSearchParams();

// story #2510 — BillingTab이 Toss 리다이렉트 왕복 복귀 판별에 useSearchParams/useRouter를
// 쓰게 되면서, 이 mock 없이는 next/navigation 실 구현(App Router context 부재)이 던진다.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => searchParams,
}));

const startBillingAuthMock = vi.fn();
const completeCheckoutMock = vi.fn();
vi.mock('./toss-checkout', () => ({
  startBillingAuth: (...args: unknown[]) => startBillingAuthMock(...args),
  completeCheckout: (...args: unknown[]) => completeCheckoutMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function statusResponse(overrides: Partial<{ tier: string; can_manage: boolean }> = {}) {
  return {
    ok: true,
    json: async () => ({
      org_id: 'org-1',
      tier: overrides.tier ?? 'free',
      billing_cycle: null,
      status: 'active',
      current_period_end: null,
      can_manage: overrides.can_manage ?? true,
    }),
  };
}

async function mount(fetchImpl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <BillingTab orgId="org-1" />
      </NextIntlClientProvider>,
    );
  });
  // status fetch effect flush
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParams = new URLSearchParams();
  replaceMock.mockClear();
  startBillingAuthMock.mockReset();
  completeCheckoutMock.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('BillingTab — 결제②-D 4티어 재편', () => {
  it('4티어 카드를 전부 렌더한다', async () => {
    await mount(async () => statusResponse());
    expect(container.textContent).toContain('Free');
    expect(container.textContent).toContain('Starter');
    expect(container.textContent).toContain('Team');
    expect(container.textContent).toContain('Business');
  });

  it('isPricePublic=false — 실가격 대신 「준비 중」 플레이스홀더만 노출한다(대표 승인 前 노출 0)', async () => {
    await mount(async () => statusResponse());
    expect(container.textContent).toContain('준비 중');
    // v2.3 seed 가격 원수(예: Starter 29,000원)가 화면에 절대 찍히면 안 된다.
    expect(container.textContent).not.toContain('29,000원');
    expect(container.textContent).not.toContain('59,000원');
    expect(container.textContent).not.toContain('219,000원');
  });

  it('현재 플랜 배지는 fetch된 tier에 붙고, 다른 카드는 잠금 CTA를 보인다', async () => {
    await mount(async () => statusResponse({ tier: 'team' }));
    expect(container.textContent).toContain('현재 이용 중');
    expect(container.textContent).toContain('공개 예정');
  });

  it('현재 tier가 팩 구매 불가(Free)면 팩 섹션을 숨긴다', async () => {
    await mount(async () => statusResponse({ tier: 'free' }));
    expect(container.textContent).not.toContain('추가 팩');
  });

  // 카디르 QA(#2866) 발견 회귀: canPurchasePacks만 보고 렌더하면 승인 前에도
  // team/business 티어에서 팩 실가격(원)이 샌다. isPricePublic=false인 동안은
  // 어떤 tier든 팩 섹션 자체가 렌더되면 안 된다.
  it.each(['team', 'business'] as const)(
    '승인 前(isPricePublic=false)이면 tier=%s 라도 팩 섹션·실가격을 노출하지 않는다',
    async (tier) => {
      await mount(async () => statusResponse({ tier }));
      expect(container.textContent).not.toContain('추가 팩');
      expect(container.textContent).not.toContain('자동화 팩');
      expect(container.textContent).not.toContain('저장 팩');
      expect(container.textContent).not.toContain('5,000원');
      expect(container.textContent).not.toContain('3,000원');
    },
  );

  it('can_manage=false면 member 안내를 보여준다', async () => {
    await mount(async () => statusResponse({ can_manage: false }));
    expect(container.textContent).toContain('결제 관리는 owner 또는 admin만 가능합니다');
  });

  it('can_manage=true면 member 안내를 숨긴다', async () => {
    await mount(async () => statusResponse({ can_manage: true }));
    expect(container.textContent).not.toContain('결제 관리는 owner 또는 admin만 가능합니다');
  });

  it('fetch 실패 시 에러 alert를 role="alert"로 노출한다', async () => {
    await mount(async () => {
      throw new Error('network down');
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('요금제 정보를 불러올 수 없습니다');
  });
});

describe('BillingTab — Toss 체크아웃 리다이렉트 왕복(story #2510)', () => {
  it('checkout=success + active 응답 → 성공 배너를 보이고 쿼리를 지운다', async () => {
    searchParams = new URLSearchParams({ checkout: 'success', tier: 'team', cycle: 'monthly', authKey: 'ak-1' });
    completeCheckoutMock.mockResolvedValue({
      kind: 'active',
      result: { org_id: 'org-1', tier: 'team', billing_cycle: 'monthly', status: 'active', current_period_start: null, current_period_end: null, declined_reason: null },
    });
    await mount(async () => statusResponse({ tier: 'free' }));

    expect(completeCheckoutMock).toHaveBeenCalledWith({ authKey: 'ak-1', tier: 'team', billingCycle: 'monthly' });
    expect(container.textContent).toContain('Team 구독이 시작되었습니다');
    expect(replaceMock).toHaveBeenCalledWith('/settings?tab=billing');
  });

  it('checkout=success + pending/declined 응답 → 거절 사유가 담긴 배너를 보인다', async () => {
    searchParams = new URLSearchParams({ checkout: 'success', tier: 'starter', cycle: 'annual', authKey: 'ak-2' });
    completeCheckoutMock.mockResolvedValue({
      kind: 'declined',
      result: { org_id: 'org-1', tier: 'starter', billing_cycle: 'annual', status: 'pending', current_period_start: null, current_period_end: null, declined_reason: '한도초과' },
    });
    await mount(async () => statusResponse());

    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain('카드 승인이 거절되었습니다');
    expect(alertEl?.textContent).toContain('한도초과');
  });

  it('checkout=success 이지만 completeCheckout이 HTTP 에러를 반환하면 에러 배너를 보인다', async () => {
    searchParams = new URLSearchParams({ checkout: 'success', tier: 'team', cycle: 'monthly', authKey: 'ak-3' });
    completeCheckoutMock.mockResolvedValue({ kind: 'error', status: 502 });
    await mount(async () => statusResponse());

    expect(container.textContent).toContain('결제 처리 중 오류가 발생했습니다');
  });

  it('checkout=fail(Toss 위젯 인증 실패/취소) → 위젯 실패 배너를 보이고 completeCheckout은 호출하지 않는다', async () => {
    searchParams = new URLSearchParams({ checkout: 'fail', code: 'USER_CANCEL', message: '취소' });
    await mount(async () => statusResponse());

    expect(container.textContent).toContain('카드 인증이 완료되지 않았습니다');
    expect(completeCheckoutMock).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalledWith('/settings?tab=billing');
  });

  it('checkout=success인데 authKey가 없으면(위젯 계약 위반) 위젯 실패 배너로 안전하게 폴백한다', async () => {
    searchParams = new URLSearchParams({ checkout: 'success', tier: 'team', cycle: 'monthly' });
    await mount(async () => statusResponse());

    expect(container.textContent).toContain('카드 인증이 완료되지 않았습니다');
    expect(completeCheckoutMock).not.toHaveBeenCalled();
  });

  it('checkout 쿼리가 없으면 아무 배너도 안 뜨고 completeCheckout도 안 부른다', async () => {
    await mount(async () => statusResponse());
    expect(completeCheckoutMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('구독이 시작되었습니다');
  });
});

describe('UpgradeCheckoutDialog — 확인 클릭 시 Toss 위젯을 연다(story #2510)', () => {
  async function mountDialog() {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <UpgradeCheckoutDialog tierId="team" cycle="monthly" currentSeats={5} onClose={() => {}} />
        </NextIntlClientProvider>,
      );
    });
  }

  // Dialog는 base-ui portal로 document.body에 렌더된다(container 안이 아님) — 기존
  // E-UI-DAEGBYEON P1-01 교훈 재확認.
  it('확인 버튼 클릭 → startBillingAuth({tier:"team", cycle:"monthly"})를 호출한다', async () => {
    startBillingAuthMock.mockReturnValue(new Promise(() => {})); // 정상 흐름은 페이지 이탈이라 resolve 안 됨
    await mountDialog();
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('카드 등록하고 결제'));
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(startBillingAuthMock).toHaveBeenCalledWith({ tier: 'team', cycle: 'monthly' });
  });

  it('위젯을 여는 데 실패하면(예: customerKey 조회 실패) 인라인 에러를 보이고 재시도 가능한 상태로 돌아온다', async () => {
    startBillingAuthMock.mockRejectedValue(new Error('customer-key fetch failed'));
    await mountDialog();
    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('카드 등록하고 결제'));
    await act(async () => {
      confirmBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('결제창을 여는 중 문제가 발생했습니다');
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('tierId="free"면 다이얼로그를 렌더하지 않는다(free는 체크아웃 대상 아님)', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <UpgradeCheckoutDialog tierId="free" cycle="monthly" currentSeats={5} onClose={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
