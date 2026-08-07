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
  it('isPricePublic=true·isCurrent=false·tier=free — 업그레이드 버튼을 렌더하지 않는다', async () => {
    const onUpgrade = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.free}
            isPricePublic
            isCurrent={false}
            displayPriceMonthlyKrw={0}
            onUpgrade={onUpgrade}
          />
        </NextIntlClientProvider>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !b.textContent?.includes('업그레이드'))).toBe(true);
  });

  it('isPricePublic=true·isCurrent=false·tier=starter — 업그레이드 버튼을 렌더하고 클릭 시 onUpgrade(tier.id)를 부른다', async () => {
    const onUpgrade = vi.fn();
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <PricingPlanCard
            tier={TIER_DEFINITIONS.starter}
            isPricePublic
            isCurrent={false}
            displayPriceMonthlyKrw={29000}
            onUpgrade={onUpgrade}
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
