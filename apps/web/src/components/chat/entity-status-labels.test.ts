import { describe, expect, it } from 'vitest';
import { entityStatusAvailability, translateEntityStatus, groupUnresolvedReferencesByType } from './entity-status-labels';

describe('entityStatusAvailability — 「아직 모름」↔「없음」을 가르는 구조적 판정(AC2·AC7)', () => {
  it.each(['story', 'task', 'doc', 'epic'])(
    '%s는 has-status(PR② v1이 실제로 배치조회할 타입 — BE #2905가 ids= 를 낸 넷)',
    (type) => {
      expect(entityStatusAvailability(type)).toBe('has-status');
    },
  );

  // hypothesis·sprint는 AC2 어휘(STATUS_LABELS)엔 있지만 오늘 fetch 경로가 없어 PR② v1
  // 칩 렌더 관점에선 no-status-concept다 — 「어휘 있음」≠「지금 채울 수 있음」(두 축이 다르다는
  // 것을 값으로 고정, 이 구분을 놓치면 그 타입 칩이 영원히 "아직 모름"에 갇힌다). sprint는
  // hypothesis보다 더 심하다 — ENTITY_API에 **단건조차** 없다(embed-card.tsx 재확認).
  it.each(['hypothesis', 'sprint', 'evidence', 'artifact', 'asset', 'unknown-type'])(
    '%s는 no-status-concept(PR② v1 fetch 경로 자체가 없다)',
    (type) => {
      expect(entityStatusAvailability(type)).toBe('no-status-concept');
    },
  );
});

describe('translateEntityStatus — 원시값 노출 금지(gate_type 사고 재발 방지)', () => {
  it('has-status 타입의 매핑된 값은 사람이 읽는 한 줄로 번역된다', () => {
    expect(translateEntityStatus('story', 'in-review')).toBe('검토 중');
    expect(translateEntityStatus('epic', 'active')).toBe('진행 중');
  });

  // translateEntityStatus는 entityStatusAvailability(PR② v1 fetch 가능 여부)와 별개 축이다
  // (파일 상단 주석 참고) — hypothesis는 칩 렌더에선 no-status-concept("상태 없음")이지만,
  // 어휘 맵 자체는 있어서 rawStatus가 (미래의 다른 경로로) 주어지면 이 함수는 정상 번역한다.
  it('hypothesis는 칩 렌더 관점에선 no-status-concept이지만 어휘 맵 번역 자체는 독립적으로 동작한다', () => {
    expect(translateEntityStatus('hypothesis', 'falsified')).toBe('반증됨');
  });

  it('매핑에 없는 값(신규 status 추가 등)은 원시값을 그대로 내지 않고 null이다', () => {
    expect(translateEntityStatus('story', 'some-brand-new-status')).toBeNull();
  });

  it('no-status-concept 타입은 rawStatus가 뭐든 null이다(그 타입엔 번역 자체가 성립 안 함)', () => {
    expect(translateEntityStatus('artifact', 'done')).toBeNull();
  });

  it('rawStatus 자체가 없으면(아직 안 왔다) null이다', () => {
    expect(translateEntityStatus('story', null)).toBeNull();
    expect(translateEntityStatus('story', undefined)).toBeNull();
  });

  // 회귀 가드 — done류를 다르게 번역하려는 시도(터미널 개념 없음 판정, 파울로 2026-07-30)를
  // 잡는다. 색/굵기 차등은 이 함수 책임이 아니지만(렌더 쪽 몫), 문구 자체가 다른 done류와
  // 「같은 급」으로 평평해야 한다 — 예: done을 "✅ 완료"처럼 특수 접두어로 튀게 하지 않는다.
  it('done류 라벨도 다른 상태와 같은 평문 형식이다(터미널 강조 접두어 없음)', () => {
    expect(translateEntityStatus('story', 'done')).toBe('완료');
    expect(translateEntityStatus('story', 'done')).not.toMatch(/[✅⭐️!]/);
  });
});

describe('groupUnresolvedReferencesByType — chat-view.tsx 배치조회 effect의 순수 로직(#2262 PR②)', () => {
  it('has-status 타입만 타입별로 묶는다(no-status-concept은 배치 대상에서 제외)', () => {
    const messages = [{
      references: [
        { target_type: 'story', target_id: 's1' },
        { target_type: 'hypothesis', target_id: 'h1' },
        { target_type: 'epic', target_id: 'e1' },
      ],
    }];
    const grouped = groupUnresolvedReferencesByType(messages, new Set());
    expect(Array.from(grouped.keys()).sort()).toEqual(['epic', 'story']);
    expect(grouped.get('story')).toEqual(['s1']);
    expect(grouped.get('epic')).toEqual(['e1']);
  });

  it('여러 메시지가 같은 엔티티를 참조해도(대화 전체 기준) 한 번만 담긴다', () => {
    const messages = [
      { references: [{ target_type: 'task', target_id: 't1' }] },
      { references: [{ target_type: 'task', target_id: 't1' }] },
    ];
    const grouped = groupUnresolvedReferencesByType(messages, new Set());
    expect(grouped.get('task')).toEqual(['t1']);
  });

  it('alreadyRequestedKeys에 이미 있으면 재요청 대상에서 빠진다(SSE로 새 메시지 도착 시 중복 fetch 방지)', () => {
    const messages = [{ references: [{ target_type: 'doc', target_id: 'd1' }, { target_type: 'doc', target_id: 'd2' }] }];
    const grouped = groupUnresolvedReferencesByType(messages, new Set(['doc:d1']));
    expect(grouped.get('doc')).toEqual(['d2']);
  });

  it('전부 이미 요청됐으면 빈 Map(size 0) — 호출부가 이걸로 fetch 스킵 여부를 판단한다', () => {
    const messages = [{ references: [{ target_type: 'story', target_id: 's1' }] }];
    const grouped = groupUnresolvedReferencesByType(messages, new Set(['story:s1']));
    expect(grouped.size).toBe(0);
  });

  it('전달된 alreadyRequestedKeys Set을 직접 변형한다(호출부 ref 재사용 계약)', () => {
    const seen = new Set<string>();
    const messages = [{ references: [{ target_type: 'story', target_id: 's1' }] }];
    groupUnresolvedReferencesByType(messages, seen);
    expect(seen.has('story:s1')).toBe(true);
  });

  it('references가 undefined인 메시지는 안전하게 스킵된다', () => {
    const grouped = groupUnresolvedReferencesByType([{ references: undefined }], new Set());
    expect(grouped.size).toBe(0);
  });
});
