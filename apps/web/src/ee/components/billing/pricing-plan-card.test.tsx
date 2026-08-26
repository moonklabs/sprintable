// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { PricingPlanCard } from './pricing-plan-card';
import { TIER_DEFINITIONS } from './pricing-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

// story #2510 — free는 체크아웃 대상이 아니다(Toss 인증 불요). isCurrent=false인 free
// 카드에 「업그레이드」 버튼이 뜨면 클릭 시 checkout({tier:'free'})로 이어져 백엔드
// PAID_TIERS 가드(422 아니라 500)까지 가서야 막히는 UX 막다른 길이 생긴다 — FE에서 미리 막는다.
describe('PricingPlanCard — free 카드는 다운그레이드 CTA를 노출하지 않는다(story #2510)', () => {
  const noop = {
    pendingTier: null,
    pendingChangeApplyAt: null,
    onDowngrade: vi.fn(),
    onCancel: vi.fn(),
    onRevokePending: vi.fn(),
  };

  it('isPricePublic=true·isCurrent=false·tier=free(현재는 유료) — 업그레이드 버튼을 렌더하지 않는다(취소 CTA만)', async () => {
    const onUpgrade = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.free}
            isPricePublic
            isCurrent={false}
            currentTier="starter"
            displayPriceMonthlyKrw={0}
            onUpgrade={onUpgrade}
            {...noop}
          />
        </NextIntlClientProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !b.textContent?.includes('업그레이드'))).toBe(true);
  });

  it('isPricePublic=true·isCurrent=false·tier=starter(현재는 free) — 업그레이드 버튼을 렌더하고 클릭 시 onUpgrade(tier.id)를 부른다', async () => {
    const onUpgrade = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.starter}
            isPricePublic
            isCurrent={false}
            currentTier="free"
            displayPriceMonthlyKrw={29000}
            onUpgrade={onUpgrade}
            {...noop}
          />
        </NextIntlClientProvider>,
      );
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('업그레이드'));
    expect(btn).toBeTruthy();
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onUpgrade).toHaveBeenCalledWith('starter');
  });
});

// story #2909②(P0) — 「하위 tier 카드 CTA 오표기」: 방향 무관하게 항상 «업그레이드»였다.
describe('PricingPlanCard — 방향(상향/하향) 판정(story #2909②)', () => {
  const noop = {
    pendingTier: null,
    pendingChangeApplyAt: null,
    onCancel: vi.fn(),
    onRevokePending: vi.fn(),
  };

  it('currentTier=business·카드=starter(하위) — «업그레이드» 대신 하향 CTA를 렌더하고 onDowngrade를 부른다', async () => {
    const onUpgrade = vi.fn();
    const onDowngrade = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.starter}
            isPricePublic
            isCurrent={false}
            currentTier="business"
            displayPriceMonthlyKrw={29000}
            onUpgrade={onUpgrade}
            onDowngrade={onDowngrade}
            {...noop}
          />
        </NextIntlClientProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !b.textContent?.includes('업그레이드'))).toBe(true);
    const downgradeBtn = buttons.find((b) => b.textContent?.includes('플랜 변경'));
    expect(downgradeBtn).toBeTruthy();
    await act(async () => {
      downgradeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDowngrade).toHaveBeenCalledWith('starter');
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it('pendingTier가 이 카드를 가리키면 «예약됨» 상태+철회 CTA를 렌더한다', async () => {
    const onRevokePending = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.starter}
            isPricePublic
            isCurrent={false}
            currentTier="business"
            displayPriceMonthlyKrw={29000}
            onUpgrade={vi.fn()}
            onDowngrade={vi.fn()}
            onCancel={vi.fn()}
            pendingTier="starter"
            pendingChangeApplyAt="2026-09-01T00:00:00+00:00"
            onRevokePending={onRevokePending}
          />
        </NextIntlClientProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const revokeBtn = buttons.find((b) => b.textContent?.includes('예약 철회'));
    expect(revokeBtn).toBeTruthy();
    await act(async () => {
      revokeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRevokePending).toHaveBeenCalled();
  });
});
