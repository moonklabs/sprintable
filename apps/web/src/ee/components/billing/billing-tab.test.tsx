// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { BillingTab } from './billing-tab';

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

  it('현재 tier가 팩 구매 가능(Team)이면 팩 섹션을 보여준다', async () => {
    await mount(async () => statusResponse({ tier: 'team' }));
    expect(container.textContent).toContain('추가 팩');
    expect(container.textContent).toContain('자동화 팩');
    expect(container.textContent).toContain('저장 팩');
  });

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
