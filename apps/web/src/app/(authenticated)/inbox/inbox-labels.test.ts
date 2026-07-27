import { describe, expect, it } from 'vitest';
import ko from '../../../../messages/ko.json';
import en from '../../../../messages/en.json';

// story #2164(2026-07-25, 까심 QA): /inbox 세 탭(오늘·알림·게이트)이 예전엔 notifications 탭
// 라벨과 페이지 헤더가 inbox.title 하나를 재사용해 "결재함" 헤더 아래 무필터 알림(채팅 포함)이
// 뜨는 결함(정신병 리스트 결재함1/2)의 근본원인이었다. 세 탭 라벨이 서로 다른 전용 키인 것과,
// 죽은 inbox.title 키가 재도입되지 않는 것을 고정한다.
describe('inbox tab labels (#2164)', () => {
  for (const [locale, messages] of [['ko', ko], ['en', en]] as const) {
    it(`${locale}: notifications/attention/gates 탭 라벨 3종이 서로 다르다`, () => {
      const notificationsLabel = messages.inbox.notificationsTabLabel;
      const attentionLabel = messages.inbox.attentionTabLabel;
      const gatesLabel = messages.cage.gateTabLabel;

      expect(notificationsLabel).toBeTruthy();
      expect(attentionLabel).toBeTruthy();
      expect(gatesLabel).toBeTruthy();

      const labels = new Set([notificationsLabel, attentionLabel, gatesLabel]);
      expect(labels.size).toBe(3);
    });

    it(`${locale}: 결재함/Approvals 이름은 게이트 탭에만 붙는다`, () => {
      const approvalsWord = locale === 'ko' ? '결재함' : 'Approvals';
      expect(messages.cage.gateTabLabel).toBe(approvalsWord);
      expect(messages.inbox.notificationsTabLabel).not.toBe(approvalsWord);
    });

    it(`${locale}: 죽은 inbox.title 키가 재도입되지 않았다`, () => {
      expect((messages.inbox as Record<string, unknown>).title).toBeUndefined();
    });

    // 파울로 정정(2026-07-25): 사이드바/모바일탭/커맨드팔레트 진입점이 전부 bare `/inbox`
    // (=알림 탭)로 착지하는데 라벨은 "결재함"이었다 — "가장 많이 눌리는 그 이름"이 여전히
    // 어긋나 있으면 반쪽. 진입점 라벨은 착지하는 탭 이름과 일치해야 한다(area 진입점 원칙).
    it(`${locale}: /inbox(bare) 진입점 라벨(GNB·모바일탭·커맨드팔레트·인박스내 뒤로가기)이 착지 탭과 일치한다`, () => {
      const approvalsWord = locale === 'ko' ? '결재함' : 'Approvals';
      const notificationsLabel = messages.inbox.notificationsTabLabel;

      // app-sidebar.tsx: <Link href="/inbox" /> 라벨
      expect(messages.nav.inbox).toBe(notificationsLabel);
      // mobile-tab-bar.tsx: { href: '/inbox', labelKey: 'approvals' } 라벨
      expect(messages.mobileTabBar.approvals).toBe(notificationsLabel);
      // command-palette.tsx: { href: '/inbox', labelKey: 'goInbox' } 라벨
      expect(messages.commandPalette.goInbox).toContain(notificationsLabel);
      // inbox/page.tsx 모바일 상세뷰 "목록으로" — 알림 목록으로 돌아가는 것이므로 동일
      expect(messages.inbox.backToList).toBe(notificationsLabel);

      // 이 넷 중 어느 것도 "결재함"/"Approvals"를 자칭하지 않는다(진짜 게이트 탭 전용 이름).
      expect(messages.nav.inbox).not.toBe(approvalsWord);
      expect(messages.mobileTabBar.approvals).not.toBe(approvalsWord);
      expect(messages.inbox.backToList).not.toBe(approvalsWord);
    });

    // gates/[id]/page.tsx의 "← 결재함" 뒤로가기는 게이트 워크플로 내부 이동이라 반대 원칙:
    // 라벨(결재함)을 착지(게이트 탭)에 맞춰야 한다 — 코드에서 '/inbox?tab=gates'로 라우팅하는
    // 것은 이 테스트가 직접 검증할 수 없어(라우팅은 e2e 영역) 라벨 값만 고정한다.
    it(`${locale}: 게이트 상세 "← 결재함" 뒤로가기는 결재함/Approvals 이름을 유지한다`, () => {
      const approvalsWord = locale === 'ko' ? '결재함' : 'Approvals';
      expect(messages.cage.gateDetailBackToInbox).toBe(approvalsWord);
    });
  }
});
