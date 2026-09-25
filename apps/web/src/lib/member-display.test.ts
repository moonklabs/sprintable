// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { disambiguateFallbackLabels, memberDisplayLabel, memberLookup, memberNameById, memberOptionLabels, memberOrAgentLabel, memberRowLabels, participantDisplayLabel, publishHistorySenderLabel } from './member-display';

function t(key: string): string {
  const table: Record<string, string> = { memberUnnamed: '이름 없는 구성원', memberUnknown: '알 수 없는 구성원', agentUnnamed: '이름 없는 에이전트' };
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
    expect(participantDisplayLabel({ name: '피오', resolved: true }, t)).toBe('피오');
  });

  // ⭐되돌리면 RED — resolved=false(진짜 orphan)면 name 값과 무관하게 「알 수 없는 구성원」.
  it('⭐resolved=false면 「알 수 없는 구성원」(orphan — email/uuid 지어내기 금지)', () => {
    expect(participantDisplayLabel({ name: null, resolved: false }, t)).toBe('알 수 없는 구성원');
  });

  // ⭐되돌리면 RED — resolved=true인데 name이 null(실존 구성원, 표시명만 없음)이면
  // 「이름 없는 구성원」이어야 한다(orphan과 다른 문구 — 같은 사실이 아니므로).
  it('⭐resolved=true인데 name이 null이면 「이름 없는 구성원」(orphan과 다른 문구)', () => {
    expect(participantDisplayLabel({ name: null, resolved: true }, t)).toBe('이름 없는 구성원');
  });

  // ⭐되돌리면 RED — `resolved` 필드 자체가 없는(레거시/아직 안 지나간) 호출부는 BE
  // ResolvedMember.resolved 기본값(True)과 짝 맞춰 "실존"으로 읽어야 한다. undefined를
  // falsy로 처리해 무조건 「알 수 없는 구성원」으로 떨어지면 이름 있는 기존 참여자들이
  // 전부 이 문구로 잘못 뜬다(실제로 최초 구현에서 이 회귀가 났었다).
  it('⭐resolved 필드 자체가 없으면(undefined) "실존"으로 읽어 name을 그대로 쓴다', () => {
    expect(participantDisplayLabel({ name: '피오' }, t)).toBe('피오');
  });
});

// [SID:4286] id→이름 표로 찾는 자리 — 갈래 넷 · id 조각 0.
describe('memberLookup 글자 갈래 — story #4286', () => {
  const ID = '05f52181-aaaa-bbbb-cccc-000000000001';
  const L = { loaded: true };
  const label = (tbl: Record<string, string | null>, id: string, loaded = true) => memberLookup(tbl, id, t, { loaded })?.label ?? null;
  it('표에 이름이 있으면 그 이름(불러오는 중이어도 먼저 온 값은 쓴다)', () => {
    expect(label({ [ID]: '페드루' }, ID)).toBe('페드루');
    expect(label({ [ID]: '페드루' }, ID, false)).toBe('페드루');
  });
  it('⭐표에 있는데 이름이 null · 빈 문자열이면 «이름 없는 구성원»', () => {
    expect(label({ [ID]: null }, ID)).toBe('이름 없는 구성원');
    expect(label({ [ID]: '' }, ID)).toBe('이름 없는 구성원');
  });
  it('⭐표를 아직 불러오는 중이면 null — «알 수 없음»을 먼저 띄우지 않는다', () => {
    expect(memberLookup({}, ID, t, { loaded: false })).toBeNull();
  });
  it('⭐표를 다 불러왔는데 없는 id면 «알 수 없는 구성원» — id 앞 조각을 싣지 않는다', () => {
    const out = label({}, ID);
    expect(out).toBe('알 수 없는 구성원');
    expect(out).not.toContain(ID.slice(0, 6));
  });
  it('프로토타입 이름(constructor · toString)이 id여도 표에 없는 것으로 읽는다', () => {
    expect(memberLookup({}, 'constructor', t, L)?.label).toBe('알 수 없는 구성원');
    expect(memberLookup({}, 'toString', t, L)?.label).toBe('알 수 없는 구성원');
  });
  it('{ name } 객체 표(memberMap 류)도 같은 갈래', () => {
    expect(memberLookup({ a: { name: '담롱' } }, 'a', t)?.label).toBe('담롱');
    expect(memberLookup({ a: { name: null } }, 'a', t)).toEqual({ label: '이름 없는 구성원', fallback: true });
    expect(memberLookup({ a: { name: '담롱' } }, 'b', t)).toEqual({ label: '알 수 없는 구성원', fallback: true });
  });
});
// [SID:4286 · 유나 결정 4] 폴백 여부를 돌려 «님» 없는 문장 키를 고르게 · 겹친 폴백에만 id 꼬리.
describe('memberLookup · disambiguateFallbackLabels · memberNameById — story #4286', () => {
  const L = { loaded: true };
  it('memberLookup: 실명은 fallback false · 이름 빔/표에 없음은 fallback true · 불러오는 중 null', () => {
    expect(memberLookup({ a: '페드루' }, 'a', t, L)).toEqual({ label: '페드루', fallback: false });
    expect(memberLookup({ a: null }, 'a', t, L)).toEqual({ label: '이름 없는 구성원', fallback: true });
    expect(memberLookup({}, 'a', t, L)).toEqual({ label: '알 수 없는 구성원', fallback: true });
    expect(memberLookup({}, 'a', t, { loaded: false })).toBeNull();
  });
  it('⭐같은 폴백이 서로 다른 id 둘 이상에 서면 그 폴백에만 id 앞 8자 꼬리', () => {
    const m = disambiguateFallbackLabels([
      { id: '05f52181-aaaa', label: '알 수 없는 구성원', fallback: true },
      { id: '9c3e7d10-bbbb', label: '알 수 없는 구성원', fallback: true },
      { id: 'x1', label: '페드루', fallback: false },
      { id: 'x2', label: '이름 없는 구성원', fallback: true },
    ]);
    expect(m.get('05f52181-aaaa')).toBe('알 수 없는 구성원 · 05f52181');
    expect(m.get('9c3e7d10-bbbb')).toBe('알 수 없는 구성원 · 9c3e7d10');
    expect(m.get('x1')).toBe('페드루');
    expect(m.get('x2')).toBe('이름 없는 구성원');
  });
  it('폴백이 하나뿐이거나 같은 id가 두 번이면 꼬리 없음', () => {
    const m = disambiguateFallbackLabels([
      { id: 'a', label: '알 수 없는 구성원', fallback: true },
      { id: 'a', label: '알 수 없는 구성원', fallback: true },
    ]);
    expect(m.get('a')).toBe('알 수 없는 구성원');
  });
  it('memberNameById(4646 모양 · fallback 필수): 목록에 있고 이름 빔 → «이름 없는 구성원» · 목록에 없음 → 호출부가 넘긴 fallback', () => {
    const map = { a: { name: '담롱' }, b: { name: null } };
    const unknown = t('memberUnknown');
    expect(memberNameById(map, 'a', t, unknown)).toBe('담롱');
    expect(memberNameById(map, 'b', t, unknown)).toBe('이름 없는 구성원');
    expect(memberNameById(map, 'zz', t, unknown)).toBe('알 수 없는 구성원');
    expect(memberNameById(map, 'zz', t, '—')).toBe('—');
    expect(memberNameById(undefined, 'zz', t, unknown)).toBe('알 수 없는 구성원');
  });
});

describe('memberOrAgentLabel — story #4286(유나 결정 1 · 2)', () => {
  it('이름이 있으면 그대로 · 비면 에이전트 «이름 없는 에이전트» / 사람 «이름 없는 구성원»', () => {
    expect(memberOrAgentLabel({ name: '담롱', type: 'agent' }, t)).toBe('담롱');
    expect(memberOrAgentLabel({ name: null, type: 'agent' }, t)).toBe('이름 없는 에이전트');
    expect(memberOrAgentLabel({ name: '', type: 'human' }, t)).toBe('이름 없는 구성원');
    expect(memberOrAgentLabel({ name: null }, t)).toBe('이름 없는 구성원');
  });
});

// story #4284 — id로 이름 찾기: «목록에 있는데 이름 없음»과 «목록에 없음»을 가른다(예전 `?.name ?? fallback`은 둘을 섞어 이름 없는
// 실존 구성원까지 id 조각 같은 fallback으로 떨어뜨렸다 — #3755 클래스).
describe('memberNameById', () => {
  const tc = (key: string) => (key === 'memberUnnamed' ? '이름 없는 구성원' : key);
  const map = { named: { name: '송윤재' }, unnamed: { name: null }, blank: { name: '' } };
  it('실명은 그대로', () => {
    expect(memberNameById(map, 'named', tc, 'x')).toBe('송윤재');
  });
  it('⭐목록에 있는데 이름이 없으면(null · 빈 문자열) «이름 없는 구성원» — fallback으로 떨어지지 않는다', () => {
    expect(memberNameById(map, 'unnamed', tc, 'unname')).toBe('이름 없는 구성원');
    expect(memberNameById(map, 'blank', tc, 'blank-')).toBe('이름 없는 구성원');
  });
  it('⭐목록에 없는 id만 호출부 fallback', () => {
    expect(memberNameById(map, 'missing-id', tc, 'missin')).toBe('missin');
    expect(memberNameById(undefined, 'x', tc, '—')).toBe('—');
  });
});

// [SID:4286 · 유나 06:48Z · 06:49Z] 꼬리 규칙은 한 곳(tailSharedFallbacks) — memberRowLabels · disambiguateFallbackLabels · memberOptionLabels가
// 같은 규칙으로 갈린다. 선택 목록(표식 없음)은 이름 빔이면 타입대로 라벨.
describe('행 꼬리 규칙 한 곳 · 선택 목록 라벨([SID:4286])', () => {
  const A = 'agent-aaaa1111'; const B = 'agent-bbbb2222'; const H = 'human-cccc3333'; const N = 'named-dddd4444';

  it('memberRowLabels 기본(«이름 없는 구성원»): 이름 없는 행 둘 이상이면 꼬리 · 역할이 그 사이 유일하면 꼬리 없음', () => {
    const rows = [{ id: A, name: null }, { id: H, name: null }, { id: N, name: '안나' }];
    const plain = memberRowLabels(rows, t, () => '');
    expect(plain.get(A)).toBe('이름 없는 구성원 · agent-aa');
    expect(plain.get(H)).toBe('이름 없는 구성원 · human-cc');
    expect(plain.get(N)).toBe('안나');
    const byRole = memberRowLabels(rows, t, (r) => (r.id === A ? '관리자' : '구성원'));
    expect(byRole.get(A)).toBe('이름 없는 구성원');
    expect(byRole.get(H)).toBe('이름 없는 구성원');
  });

  it('memberOptionLabels(선택 목록): 이름 빔이면 타입대로 · 라벨이 달라 겹치지 않으면 꼬리 없음', () => {
    const labels = memberOptionLabels([{ id: A, name: null, type: 'agent' }, { id: H, name: null, type: 'human' }, { id: N, name: '안나', type: 'human' }], t);
    expect(labels.get(A)).toBe('이름 없는 에이전트');
    expect(labels.get(H)).toBe('이름 없는 구성원');
    expect(labels.get(N)).toBe('안나');
  });

  it('memberOptionLabels: 같은 타입 라벨이 서로 다른 둘 이상이면 그 행에만 꼬리', () => {
    const labels = memberOptionLabels([{ id: A, name: null, type: 'agent' }, { id: B, name: null, type: 'agent' }, { id: H, name: null, type: 'human' }], t);
    expect(labels.get(A)).toBe('이름 없는 에이전트 · agent-aa');
    expect(labels.get(B)).toBe('이름 없는 에이전트 · agent-bb');
    expect(labels.get(H)).toBe('이름 없는 구성원');
  });

  it('disambiguateFallbackLabels도 같은 규칙(같은 id 반복은 한 사람)', () => {
    const m = disambiguateFallbackLabels([
      { id: A, label: '알 수 없는 구성원', fallback: true },
      { id: A, label: '알 수 없는 구성원', fallback: true },
      { id: B, label: '알 수 없는 구성원', fallback: true },
    ]);
    expect(m.get(A)).toBe('알 수 없는 구성원 · agent-aa');
    expect(m.get(B)).toBe('알 수 없는 구성원 · agent-bb');
  });
});

