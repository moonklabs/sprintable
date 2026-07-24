// @vitest-environment jsdom
//
// story #2160 — 오르테가 리뷰(PR#2467) 회귀가드: resetSessionExpired()의 프로덕션 호출처가
// 0건이라, 이 모달을 ESC/바깥클릭으로 닫으면 signaled=true인 채 fetchWithAuth가 영구 단락돼
// "앱이 되살아날 길 없이 조용히 죽는" 것 — #2160이 고치려던 증상 그대로다. 유일한 출구가
// 재로그인 CTA(하드 내비게이션) 하나뿐인지를 고정한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SessionExpiredDialog } from './session-expired-dialog';
import { resetSessionExpired, signalSessionExpired } from '@/lib/auth/session-expired-signal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXPIRED_TITLE = koMessages.session.expiredTitle;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetSessionExpired();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  resetSessionExpired();
});

function renderDialog() {
  return act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <SessionExpiredDialog />
      </NextIntlClientProvider>,
    );
  });
}

describe('SessionExpiredDialog — 유일한 출구는 재로그인 CTA다(#2160)', () => {
  it('signalSessionExpired 후 모달이 뜬다', async () => {
    await renderDialog();
    await act(async () => { signalSessionExpired(); });
    expect(document.body.textContent).toContain(EXPIRED_TITLE);
  });

  it('ESC 키를 눌러도 모달이 닫히지 않는다 — 안 그러면 signaled=true인 채 fetchWithAuth가 영구 단락된다', async () => {
    await renderDialog();
    await act(async () => { signalSessionExpired(); });
    expect(document.body.textContent).toContain(EXPIRED_TITLE);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).toContain(EXPIRED_TITLE); // 여전히 열려있음
  });

  it('바깥(backdrop) 클릭으로도 닫히지 않는다', async () => {
    await renderDialog();
    await act(async () => { signalSessionExpired(); });
    expect(document.body.textContent).toContain(EXPIRED_TITLE);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(document.body.textContent).toContain(EXPIRED_TITLE); // 여전히 열려있음
  });

  it('닫기(X) 버튼이 렌더되지 않는다 — 유일한 출구는 재로그인 CTA뿐이어야 한다', async () => {
    await renderDialog();
    await act(async () => { signalSessionExpired(); });
    expect(document.body.textContent).toContain(EXPIRED_TITLE);
    expect(document.body.querySelector('[data-slot="dialog-close"]')).toBeNull();
  });
});
