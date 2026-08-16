import { describe, expect, it } from 'vitest';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES } from '../src/lib/legacy-resource-tables';
import { findRenamedTargetsMissingFromMigrated } from './verify-migrated-resources-sync';

describe('findRenamedTargetsMissingFromMigrated — 순수 판정 함수(AC1)', () => {
  it('신 이름이 MIGRATED_RESOURCES 키에 있으면 위반 0건이다', () => {
    const violations = findRenamedTargetsMissingFromMigrated(
      { epics: 'goals' },
      { epics: [], goals: [] },
    );
    expect(violations).toEqual([]);
  });

  // ⭐양성대조(AC2) — 실사고(#2016, epics→goals) 그대로 모사: RENAMED_RESOURCES엔 신 이름이
  // 추가됐는데 MIGRATED_RESOURCES엔 그 신 이름(goals)이 빠진 상태. fix 전 코드였다면 이
  // 케이스를 잡을 수단이 없었다 — 판정 함수가 정확히 이 모양에서 RED가 나는지 고정한다.
  it('#2016 실사고 픽스처 — 신 이름이 MIGRATED_RESOURCES에 없으면 잡는다(양성대조)', () => {
    const violations = findRenamedTargetsMissingFromMigrated(
      { epics: 'goals' },
      { epics: [] }, // goals 키 누락 — 실제 사고 당시 모양
    );
    expect(violations).toEqual(['goals']);
  });

  it('여러 리네임이 동시에 어긋나도 전부 잡는다', () => {
    const violations = findRenamedTargetsMissingFromMigrated(
      { a: 'b', c: 'd' },
      { a: [] },
    );
    expect(violations).toEqual(['b', 'd']);
  });

  it('MIGRATED_RESOURCES 키가 비어 있어도(예외 상황) 안 죽고 전부 위반으로 잡는다', () => {
    const violations = findRenamedTargetsMissingFromMigrated({ epics: 'goals' }, {});
    expect(violations).toEqual(['goals']);
  });
});

// story #1971 — 실 데이터(legacy-resource-tables.ts) 전수 대조. 이 테스트가 RED면 CI 가드
// 스크립트(main())도 똑같이 RED다(같은 함수·같은 소스를 그대로 쓴다).
describe('실 데이터(legacy-resource-tables.ts) 대조', () => {
  it('현재 RENAMED_RESOURCES 값이 전부 MIGRATED_RESOURCES 키에 있다(#2016 재발 없음)', () => {
    const violations = findRenamedTargetsMissingFromMigrated(RENAMED_RESOURCES, MIGRATED_RESOURCES);
    expect(violations).toEqual([]);
  });
});

// story #1971 AC3 — 이 가드가 못 잡는 것(스코프 밖)은 verify-migrated-resources-sync.ts 상단
// docstring ㉠㉡㉢에 선언돼 있다: RENAMED_RESOURCES의 키(옛 이름) 쪽, RETIRED_RESOURCES의
// 값, MIGRATED_RESOURCES 서브패스 제외 목록의 실존 여부. 함수 시그니처 자체가 `renamed:
// Record<string,string>` 하나만 받아 RETIRED_RESOURCES를 애초에 볼 수 없게 만든다(런타임
// 분기가 아니라 타입으로 경계를 고정 — "안 본다"고 선언한 축을 코드가 물리적으로 못 보게).
