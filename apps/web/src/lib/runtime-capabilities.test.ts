import { describe, expect, it } from 'vitest';
import { runtimeLabel, RUNTIME_REGISTRY } from './runtime-capabilities';

// story #3103(DS·후속, 3505 design 판정 필수) — runtimeLabel()의 미등록 폴백을
// `?? key`(원값 보존)에서 `?? null`로 닫는다. registry 미등재 runtime_type이 raw key
// 그대로 UI에 노출되던 잠복 클래스를 이 계약 변경으로 전면 차단한다.
describe('runtimeLabel — story #3103 미등록 폴백 null 계약', () => {
  it('null/undefined/빈 문자열은 null을 반환한다(기존 계약, 무변경)', () => {
    expect(runtimeLabel(null)).toBeNull();
    expect(runtimeLabel(undefined)).toBeNull();
    expect(runtimeLabel('')).toBeNull();
  });

  it('registry 미등록 키는 raw key를 보존하지 않고 null을 반환한다(신규 계약)', () => {
    expect(runtimeLabel('unknown-runtime-x')).toBeNull();
    expect(runtimeLabel('internal-beta')).toBeNull();
  });

  it('양성대조 — registry에 등록된 9종 키는 전부 고유명사 라벨을 그대로 반환한다(회귀 없음)', () => {
    for (const def of RUNTIME_REGISTRY) {
      expect(runtimeLabel(def.key)).toBe(def.label);
    }
  });
});
