// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { BillingTab, PackPurchaseDialog, UpgradeCheckoutDialog } from './billing-tab';

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

// story #40659941(#2728 픽셀 검증 블로커) — FASTAPI_URL 직접 fetch를 same-origin 프록시로
// 수렴한 뒤부터 응답이 proxyToFastapiWrapped의 {data:...} 봉투를 쓴다(customer-key/checkout
// 프록시와 동일 계약) — mock도 그 봉투 그대로 재현.
function statusResponse(overrides: Partial<{ tier: string; can_manage: boolean }> = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        org_id: 'org-1',
        tier: overrides.tier ?? 'free',
        billing_cycle: null,
        status: 'active',
        current_period_end: null,
        can_manage: overrides.can_manage ?? true,
      },
    }),
  };
}

// story #2728 — mount()이 두 fetch(status·platform-settings)를 URL로 라우팅한다. 기존
// 16개 호출부는 status만 신경 쓰면 되도록 platformSettings 기본값을 이 파일이 원래
// 가정하던 상태(IS_PRICE_PUBLIC=true 시절과 동형 — 가격 공개+체크아웃 가능)로 맞춰
// 무회귀시킨다. off 상태 자체를 검증하는 테스트만 명시로 override.
function platformSettingsResponse(overrides: Partial<{ billing_price_public: boolean; billing_checkout_enabled: boolean }> = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        billing_price_public: overrides.billing_price_public ?? true,
        billing_checkout_enabled: overrides.billing_checkout_enabled ?? true,
      },
    }),
  };
}

async function mount(
  statusFetchImpl: () => Promise<unknown>,
  platformSettingsFetchImpl: () => Promise<unknown> = async () => platformSettingsResponse(),
) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/platform-settings')) return platformSettingsFetchImpl();
    return statusFetchImpl();
  }));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <BillingTab orgId="org-1" />
      </NextIntlClientProvider>,
    );
  });
  // status + platform-settings fetch effect flush
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

  // story #2605 — 대표 승인 완료(2026-08-13)로 IS_PRICE_PUBLIC=true 전환. 이 파일의 나머지
  // 테스트는 승인 前(false) 상태를 검증하던 것들을 뒤집어 승인 後(실가격 노출) 상태를 고정한다.
  it('isPricePublic=true — v2.3 정본 실가격(원)이 노출된다(「준비 중」 플레이스홀더는 안 뜬다)', async () => {
    await mount(async () => statusResponse());
    expect(container.textContent).not.toContain('준비 중');
    expect(container.textContent).toContain('29,000원');
    expect(container.textContent).toContain('59,000원');
    expect(container.textContent).toContain('219,000원');
  });

  // story #2605 AC4 — 토스 심사: 연간 구독은 서비스 제공기간이 12개월임을 명확히 표기해야
  // 한다(1년 초과 시 결제 서비스 이용 불가 룰과 대칭). 연 결제 토글 라벨에 고정한다.
  it('연 결제 토글에 「12개월」이 명시된다(토스 서비스제공기간 표기 요건)', async () => {
    await mount(async () => statusResponse());
    expect(container.textContent).toContain('12개월');
  });

  it('현재 플랜 배지는 fetch된 tier에 붙고, 다른 카드는 업그레이드 CTA를 보인다', async () => {
    await mount(async () => statusResponse({ tier: 'team' }));
    expect(container.textContent).toContain('현재 이용 중');
    expect(container.textContent).toContain('업그레이드');
  });

  // story #2403 후속(2026-08-17) — prod org_subscriptions 실측(tier='pro' 3건 실존) 기반
  // 회귀가드. toTierId()가 'pro'를 몰라 TIER_ORDER.includes 실패 → 'free'로 조용히 폴백하면
  // 유료 결제 중인 조직이 화면엔 무료로 보인다(실해악). DOM 셀렉터는 팩 섹션도 카드와 같은
  // className을 재사용해 불안정(6개 매치, 카드 4개 아님) — 대신 textContent의 문서 순서로
  // "현재 이용 중" 배지가 Free~Starter 구간엔 없고 Business 헤딩 이후(마지막 티어라 다음
  // 헤딩 없음)에만 있는지를 인덱스로 가른다.
  it('tier="pro"(레거시 Polar)는 Free가 아니라 Business로 매핑된다', async () => {
    await mount(async () => statusResponse({ tier: 'pro' }));
    const text = container.textContent ?? '';
    const starterIdx = text.indexOf('Starter');
    const businessIdx = text.indexOf('Business');
    const badgeIdx = text.indexOf('현재 이용 중');
    expect(businessIdx).toBeGreaterThan(starterIdx); // TIER_ORDER상 Business가 마지막
    expect(badgeIdx).toBeGreaterThan(businessIdx); // 배지가 Business 헤딩 뒤(=그 카드 안)에만 있음
    expect(text.indexOf('현재 이용 중', badgeIdx + 1)).toBe(-1); // 딱 1번만(Free에 안 붙음)
  });

  it('현재 tier가 팩 구매 불가(Free)면 팩 섹션을 숨긴다', async () => {
    await mount(async () => statusResponse({ tier: 'free' }));
    expect(container.textContent).not.toContain('추가 팩');
  });

  // 카디르 QA(#2866) 발견 회귀의 반대축 — canPurchasePacks=true인 team/business에서는
  // 승인 後(isPricePublic=true) 팩 섹션·실가격이 실제로 노출돼야 한다(안 뜨면 회귀).
  it.each(['team', 'business'] as const)(
    '승인 後(isPricePublic=true)이면 tier=%s 는 팩 섹션·실가격을 노출한다',
    async (tier) => {
      await mount(async () => statusResponse({ tier }));
      expect(container.textContent).toContain('추가 팩');
      expect(container.textContent).toContain('자동화 팩');
      expect(container.textContent).toContain('저장 팩');
      expect(container.textContent).toContain('5,000원');
      expect(container.textContent).toContain('3,000원');
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

describe('BillingTab — platform-settings 소비(story #2728, 선생님 결정②③ 집행)', () => {
  it('billing_price_public=false면 가격이 안 뜬다(하드코딩 IS_PRICE_PUBLIC 철거 확認)', async () => {
    await mount(
      async () => statusResponse(),
      async () => platformSettingsResponse({ billing_price_public: false }),
    );
    expect(container.textContent).toContain('준비 중');
    expect(container.textContent).not.toContain('29,000원');
  });

  it('/api/v2/platform-settings fetch 실패 시 안전측 기본값(false)으로 폴백 — 가격이 조용히 새지 않는다', async () => {
    let callCount = 0;
    await mount(
      async () => statusResponse(),
      async () => {
        callCount += 1;
        throw new Error('platform-settings network down');
      },
    );
    expect(callCount).toBeGreaterThan(0);
    expect(container.textContent).toContain('준비 중');
    expect(container.textContent).not.toContain('29,000원');
  });

  it('billing_checkout_enabled=false면(가격은 공개돼도) 업그레이드 클릭이 결제 다이얼로그를 안 연다', async () => {
    await mount(
      async () => statusResponse({ tier: 'free', can_manage: true }),
      async () => platformSettingsResponse({ billing_price_public: true, billing_checkout_enabled: false }),
    );
    const upgradeBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('업그레이드'));
    expect(upgradeBtn).toBeTruthy();
    await act(async () => { upgradeBtn!.click(); await Promise.resolve(); await Promise.resolve(); });
    // UpgradeCheckoutDialog(Radix Dialog)는 document.body로 portal되므로 container 안이
    // 아니라 document.body를 봐야 한다(container만 보면 항상 빈 채로 통과하는 거짓양성
    // — 직접 겪은 함정, 주석으로 남김). tierId===null이면 렌더 자체를 안 하므로(billing-
    // tab.tsx의 `if (tierId == null...) return null`) 다이얼로그 타이틀("로 업그레이드")
    // 부재로 "setUpgradeTarget이 실질적으로 다이얼로그를 못 열었다"를 확認.
    expect(document.body.textContent).not.toContain('로 업그레이드');
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
    // 유나 design 가디언(2026-08-07) — declined는 502 등 시스템오류(destructive)와 색으로
    // 구분돼야 한다. warning이어야지 destructive면 안 된다.
    expect(alertEl?.className).toContain('warning-tint');
    expect(alertEl?.className).not.toContain('destructive-tint');
    expect(alertEl?.textContent).toContain('구독은 시작되지 않았고 청구된 금액도 없습니다');
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

describe('PackPurchaseDialog — 청구 확인창은 VAT 가산액을 그대로 보인다(story #3097)', () => {
  // story #3097(선생님 결정 2026-08-26) — v2.3 확정가=공급가, BE(billing_pack.py)가 이제
  // 청구 시점에 실제로 VAT 10%를 가산한다. 이 확인창(청구 직전)도 UpgradeCheckoutDialog와
  // 동일 원칙 — 실 청구액을 그대로 보여야 한다(withVatKrw 적용, "VAT 별도" 카피는 더는
  // 정직하지 않음 — 실제로 VAT가 걸리기 때문).
  it('automation 팩 1개 — 공급가 5,000원 → 표시 5,500원 "(VAT 포함)"', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PackPurchaseDialog target={{ kind: 'automation', quantity: 1 }} onClose={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    expect(document.body.textContent).toContain('5,500원');
    expect(document.body.textContent).toContain('VAT 포함');
    expect(document.body.textContent).not.toContain('VAT 별도');
  });

  it('storage 팩 2개 — 공급가 3,000원×2=6,000원 → 표시 6,600원 "(VAT 포함)"', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PackPurchaseDialog target={{ kind: 'storage', quantity: 2 }} onClose={() => {}} />
        </NextIntlClientProvider>,
      );
    });
    expect(document.body.textContent).toContain('6,600원');
    expect(document.body.textContent).toContain('VAT 포함');
  });
});
