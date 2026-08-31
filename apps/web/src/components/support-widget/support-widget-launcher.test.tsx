// @vitest-environment jsdom
//
// story #3260(지원v1 v1·2위젯) — 플로팅 런처+오버레이 셸. Support Gateway(#f2a27d2a) 계약이
// 아직 없어 use-support-widget-session.ts는 항상 'unavailable'을 반환한다(no-fiction) — 이
// 테스트는 그 정직한 상태가 실제로 렌더되는지, 그리고 셸 자체의 인터랙션(열기/닫기/Escape)이
// 회귀 없이 동작하는지를 검증한다. 실 네트워크/SSE 계약은 스코프 밖(고아 슬롯 결함 클래스
// 재발 방지 원칙상 이 셸은 애초에 아무 SSE도 구독하지 않는다).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SupportWidgetLauncher } from './support-widget-launcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

async function mount() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SupportWidgetLauncher />
      </NextIntlClientProvider>,
    );
  });
}

describe('SupportWidgetLauncher — story #3260 셸', () => {
  it('초기 상태는 런처 버튼만 뜨고 오버레이 패널은 없다', async () => {
    await mount();
    expect(container.querySelector('button')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('런처 클릭 시 오버레이 패널이 열리고, 다시 클릭하면 닫힌다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape 키로 열린 패널이 닫힌다', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('본체 대화가 아니라 Sprintable에 직접 연결된다는 문구가 패널에 드러난다(외부 위젯 패키징 요건)', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain(koMessages.supportWidget.panelSubtitle);
  });

  it('Support Gateway 계약 착지 전 — 「준비 중」 정직한 상태만 보이고, 가짜 응답/입력창은 없다(AC5 무신호 금지 원칙의 셸 단계 적용)', async () => {
    await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain(koMessages.supportWidget.unavailableTitle);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
  });
});
