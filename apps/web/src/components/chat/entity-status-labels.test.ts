import { describe, expect, it } from 'vitest';
import { entityStatusAvailability, translateEntityStatus } from './entity-status-labels';

describe('entityStatusAvailability — 「아직 모름」↔「없음」을 가르는 구조적 판정(AC2·AC7)', () => {
  it.each(['story', 'task', 'doc', 'hypothesis', 'sprint', 'epic'])(
    '%s는 has-status(실측된 status 어휘가 있다)',
    (type) => {
      expect(entityStatusAvailability(type)).toBe('has-status');
    },
  );

  it.each(['artifact', 'evidence', 'asset', 'unknown-type'])(
    '%s는 no-status-concept(status 컬럼·fetch 경로 자체가 없다)',
    (type) => {
      expect(entityStatusAvailability(type)).toBe('no-status-concept');
    },
  );
});

describe('translateEntityStatus — 원시값 노출 금지(gate_type 사고 재발 방지)', () => {
  it('has-status 타입의 매핑된 값은 사람이 읽는 한 줄로 번역된다', () => {
    expect(translateEntityStatus('story', 'in-review')).toBe('검토 중');
    expect(translateEntityStatus('epic', 'active')).toBe('진행 중');
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
