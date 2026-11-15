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

    // 파울로 정정(2026-07-25) → story #4885(UI-2 AC4 PR 1): 진입점 라벨은 착지하는 탭 이름과 일치해야 한다(area 진입점 원칙). 예전엔 사이드바/커맨드팔레트가 bare `/inbox`(=알림 탭)에 착지하며
    // 라벨 `nav.inbox`(=알림)를 썼으나, 새 구조의 사이드바 · 팔레트 «결재» 항목은 게이트 탭(`/inbox?tab=gates`)에 착지하므로 라벨도 «결재»(nav.approvals)다(폰 하단의 «결재» 탭은 story #4885 폰 탭 넷에서 «홈»이 품어 없어졌다).
    // bare `/inbox`(알림 탭)로 가는 길은 알림 종 · 인박스 내 뒤로가기뿐이라 `nav.inbox` 키는 걷혔다(재도입 금지).
    it(`${locale}: 사이드바·커맨드팔레트 «결재» 진입점은 게이트 탭에 착지하므로 «결재»이고 알림 라벨이 아니다`, () => {
      const notificationsLabel = messages.inbox.notificationsTabLabel;
      expect(messages.nav.approvals).not.toBe(notificationsLabel);
      expect((messages.nav as Record<string, unknown>).inbox).toBeUndefined();
      // command-palette.tsx가 nav 항목 라벨을 goDestination의 {label}에 그대로 꿰어 렌더한다(전용 키 없음, 사본 0).
      expect(messages.commandPalette.goDestination).toContain('{label}');
      // inbox/page.tsx 모바일 상세뷰 "목록으로" — 알림 목록으로 돌아가는 것이므로 알림 탭 이름과 동일
      expect(messages.inbox.backToList).toBe(notificationsLabel);
      expect(messages.inbox.backToList).not.toBe(locale === 'ko' ? '결재함' : 'Approvals');
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
