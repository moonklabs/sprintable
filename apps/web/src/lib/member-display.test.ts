// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { memberDisplayLabel, publishHistorySenderLabel } from './member-display';

function t(key: string): string {
  const table: Record<string, string> = { memberUnnamed: '이름 없는 구성원' };
  return table[key] ?? key;
}

function tEvents(key: string): string {
  const table: Record<string, string> = { eventPublishHistoryUnknownSender: '알 수 없음' };
  return table[key] ?? key;
}

describe('memberDisplayLabel — story #3755', () => {
  it('name이 있으면 그대로 돌린다', () => {
    expect(memberDisplayLabel('피오', t)).toBe('피오');
  });

  it('⭐name이 null이면 t(memberUnnamed)로 폴백한다(email/id 지어내기 금지)', () => {
    expect(memberDisplayLabel(null, t)).toBe('이름 없는 구성원');
  });

  it('name이 undefined여도 같은 폴백(BE 계약이 null | undefined 둘 다일 수 있는 소비처 대응)', () => {
    expect(memberDisplayLabel(undefined, t)).toBe('이름 없는 구성원');
  });

  // ⭐되돌리면 RED — 유나 디자인 게이트 적기만②(2026-09-09). `??`(null/undefined만 폴백)
  // 로 되돌리면 빈 문자열이 그대로 통과해 화면에 빈 칸이 뜬다.
  it('⭐빈 문자열도 같은 폴백으로 묶인다(name 없다는 같은 사실 — falsy 전체를 폴백)', () => {
    expect(memberDisplayLabel('', t)).toBe('이름 없는 구성원');
  });
});

// story #3755 CHANGES(유나 디자인 게이트 지적, 2026-09-09) — sender_id 없음(발신자 정보
// 자체가 없음)과 sender_id 있는데 sender_name만 null(실존 발신자, display_name 미설정 —
// #3755 BE fix가 이제 email 대신 정직한 None을 돌린다)이 예전엔 둘 다 「알 수 없음」으로
// 뭉뚱그려졌다 — activity-log-view.tsx auditActorProps와 동형 처방으로 갈랐다. 카디르 QA
// 지적(2026-09-09) — page.tsx는 Next App Router named export 화이트리스트 대상이라 이
// 헬퍼를 거기 두면 안 됨(next build 실패, tsc/vitest는 못 잡는 층) — 이 모듈로 이관.
describe('publishHistorySenderLabel — story #3755', () => {
  it('sender_id가 없으면(발신자 정보 자체 없음) 「알 수 없음」', () => {
    expect(publishHistorySenderLabel({ sender_id: null, sender_name: null }, tEvents, t)).toBe('알 수 없음');
  });

  it('sender_id·sender_name 둘 다 있으면 그 이름 그대로', () => {
    expect(publishHistorySenderLabel({ sender_id: 's-1', sender_name: '페드루 올리베이라' }, tEvents, t)).toBe('페드루 올리베이라');
  });

  // ⭐되돌리면 RED — sender_id는 있는데(실존 발신자) sender_name이 null이면 이젠 「알 수
  // 없음」이 아니라 「이름 없는 구성원」이어야 한다(활동 로그와 같은 낱말 — 같은 사실은
  // 같은 낱말로, 유나 지적①).
  it('⭐sender_id는 있는데 sender_name이 null이면 「이름 없는 구성원」(「알 수 없음」 아님)', () => {
    expect(publishHistorySenderLabel({ sender_id: 's-2', sender_name: null }, tEvents, t)).toBe('이름 없는 구성원');
  });
});
