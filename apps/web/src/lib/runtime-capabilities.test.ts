import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTOR_BADGE_REGISTRY, runtimeLabel, RUNTIME_REGISTRY } from './runtime-capabilities';

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

  it('양성대조 — registry에 등록된 10종 키는 전부 고유명사 라벨을 그대로 반환한다(회귀 없음)', () => {
    for (const def of RUNTIME_REGISTRY) {
      expect(runtimeLabel(def.key)).toBe(def.label);
    }
  });
});

// story #3107 delta(유나 design 판정 2026-08-26) — sprintable-symbol.svg는 /icon.svg(파비콘)의
// 흰 배경 rect만 제거한 투명 파생판이어야 한다. 이 테스트는 두 파일의 <path> 마크 자체
// (path data·색상)가 바이트 단위로 동일함을 고정해, 향후 누군가 "겸사겸사" 파생판을
// 리터치하는 회귀를 막는다(무변형 원칙의 코드 레벨 가드).
describe('system-publisher 아이콘 자산 — 파비콘 대비 무변형(흰 배경 rect만 제거)', () => {
  it('sprintable-symbol.svg의 <g>...마크 부분이 icon.svg와 바이트 단위로 동일하다', () => {
    const faviconSvg = readFileSync(join(__dirname, '../app/icon.svg'), 'utf8');
    const symbolPath = CONNECTOR_BADGE_REGISTRY['system-publisher'].asset!.replace(/^\//, '');
    const symbolSvg = readFileSync(join(__dirname, '../../public', symbolPath), 'utf8');

    const markOf = (svg: string) => svg.slice(svg.indexOf('<g '));
    expect(markOf(symbolSvg).trim()).toBe(markOf(faviconSvg).trim());
    // 파생판에는 흰 배경 rect가 없어야 한다(디스크의 고정-라이트 배경이 그 역할을 대신함).
    expect(symbolSvg).not.toContain('<rect');
  });
});
