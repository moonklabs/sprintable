// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { memberDisplayLabel, participantDisplayLabel, publishHistorySenderLabel } from './member-display';

function t(key: string): string {
  const table: Record<string, string> = { memberUnnamed: '이름 없는 구성원' };
  return table[key] ?? key;
}

// chats 네임스페이스(unknownMember는 t('common')이 아니라 t('chats') 쪽 키 — 실 호출부와
// 동형으로 별도 함수).
function tChats(key: string): string {
  const table: Record<string, string> = { unknownMember: '알 수 없는 구성원' };
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

// story #3758(9번째, PO 決 2026-09-09) — 대화 참여자 전용. resolved 비트로 「알 수 없는
// 구성원」(orphan)과 「이름 없는 구성원」(실존·표시명 없음)을 가른다.
describe('participantDisplayLabel — story #3758', () => {
  it('name이 있으면 resolved 무관 그대로 돌린다', () => {
    expect(participantDisplayLabel({ name: '피오', resolved: true }, tChats, t)).toBe('피오');
  });

  // ⭐되돌리면 RED — resolved=false(진짜 orphan)면 name 값과 무관하게 「알 수 없는 구성원」.
  it('⭐resolved=false면 「알 수 없는 구성원」(orphan — email/uuid 지어내기 금지)', () => {
    expect(participantDisplayLabel({ name: null, resolved: false }, tChats, t)).toBe('알 수 없는 구성원');
  });

  // ⭐되돌리면 RED — resolved=true인데 name이 null(실존 구성원, 표시명만 없음)이면
  // 「이름 없는 구성원」이어야 한다(orphan과 다른 문구 — 같은 사실이 아니므로).
  it('⭐resolved=true인데 name이 null이면 「이름 없는 구성원」(orphan과 다른 문구)', () => {
    expect(participantDisplayLabel({ name: null, resolved: true }, tChats, t)).toBe('이름 없는 구성원');
  });

  // ⭐되돌리면 RED — `resolved` 필드 자체가 없는(레거시/아직 안 지나간) 호출부는 BE
  // ResolvedMember.resolved 기본값(True)과 짝 맞춰 "실존"으로 읽어야 한다. undefined를
  // falsy로 처리해 무조건 「알 수 없는 구성원」으로 떨어지면 이름 있는 기존 참여자들이
  // 전부 이 문구로 잘못 뜬다(실제로 최초 구현에서 이 회귀가 났었다).
  it('⭐resolved 필드 자체가 없으면(undefined) "실존"으로 읽어 name을 그대로 쓴다', () => {
    expect(participantDisplayLabel({ name: '피오' }, tChats, t)).toBe('피오');
  });
});
