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
  }
});
