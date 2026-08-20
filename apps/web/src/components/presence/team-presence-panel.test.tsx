// @vitest-environment jsdom
//
// story #2852(2836 FE 조각) AC1/AC2/AC3 — presence 패널의 「인증 실패」 뱃지가 실제로 렌더되고
// destructive(빨강)를 안 쓰는지, reason이 raw enum 아니라 title 툴팁으로 유저 어휘 매핑되는지
// 실 마운트로 검증한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TeamPresencePanel } from './team-presence-panel';
import type { TeamPresenceItem } from './use-team-presence';

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function presenceItem(overrides: Partial<TeamPresenceItem>): TeamPresenceItem {
  return { member_id: 'm1', name: '디디 은두카쿠', working: false, presence_status: 'online', ...overrides };
}

describe('TeamPresencePanel — 인증 실패 뱃지(story #2852)', () => {
  it('authFailureByMember에 해당 member_id가 있으면 뱃지가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <TeamPresencePanel
          items={[presenceItem({})]}
          authFailureByMember={{ m1: { reason: 'expired', failureCount: 6 } }}
        />,
      ));
    });
    expect(container.textContent).toContain(koMessages.presence.authFailureBadge);
  });

  it('authFailureByMember에 없으면 뱃지가 안 뜬다(다른 멤버는 무영향)', async () => {
    await act(async () => {
      root.render(wrap(
        <TeamPresencePanel
          items={[presenceItem({})]}
          authFailureByMember={{ 'other-member': { reason: 'expired', failureCount: 6 } }}
        />,
      ));
    });
    expect(container.textContent).not.toContain(koMessages.presence.authFailureBadge);
  });

  // AC1 — 인증 실패는 복구 가능한 주의 상태이지 kill이 아니다. destructive 금지.
  it('뱃지 색이 destructive(빨강)가 아니다(AC1)', async () => {
    await act(async () => {
      root.render(wrap(
        <TeamPresencePanel
          items={[presenceItem({})]}
          authFailureByMember={{ m1: { reason: 'revoked', failureCount: 4 } }}
        />,
      ));
    });
    expect(container.innerHTML).not.toMatch(/bg-destructive/);
    expect(container.querySelector('.bg-warning-tint')).toBeTruthy();
  });

  // AC3 — reason enum을 raw로 보이지 않고 title 툴팁에 유저 어휘로 매핑한다.
  it('뱃지 title 툴팁에 raw enum이 아니라 유저 어휘+횟수가 담긴다(AC3)', async () => {
    await act(async () => {
      root.render(wrap(
        <TeamPresencePanel
          items={[presenceItem({})]}
          authFailureByMember={{ m1: { reason: 'revoked', failureCount: 4 } }}
        />,
      ));
    });
    const badge = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === koMessages.presence.authFailureBadge);
    expect(badge?.getAttribute('title')).toBe(koMessages.presence.authFailureTooltipRevoked.replace('{n}', '4'));
    expect(badge?.getAttribute('title')).not.toContain('revoked');
  });
});
