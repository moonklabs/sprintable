/**
 * story #1971 회귀가드 — `legacy-resource-tables.ts`의 두 표(`RENAMED_RESOURCES`·
 * `MIGRATED_RESOURCES`)가 손으로 따로 유지되는데, 서로 지켜야 하는 불변식이 무가드였다:
 * **`RENAMED_RESOURCES`의 값(리네임 후 신 이름)은 반드시 `MIGRATED_RESOURCES`의 키에도
 * 있어야 한다.** `proxy.ts`의 `redirectLegacyResourcePath`가 bare(ws/proj 세그먼트가 아직
 * 없는) 딥링크를 `[ws]/[proj]/{resource}`로 채워 넣는 첫 관문인데, 그 판정이 정확히
 * `resourceName in MIGRATED_RESOURCES`다 — 신 이름이 그 표에 없으면 bare 딥링크(콜드
 * 진입·북마크·검색결과·리네임 전에 이미 뿌려진 알림)가 ws/proj를 못 채운 채 Next 자체 404로
 * 떨어진다. `redirectRenamedResourcePath`(옛 이름→신 이름 치환)는 `segments[2]`, 즉 이미
 * ws/proj가 채워진 경로만 보므로 이 첫 관문을 대신해 주지 않는다.
 *
 * ⭐실사고 전례(2026-07-27 무렵, #2016) — `epics→goals` 리네임 때 `RENAMED_RESOURCES`엔
 * `epics: 'goals'`를 추가했지만 `MIGRATED_RESOURCES`엔 신 이름 `goals`를 안 넣었다. 결과:
 * 옛 bare `/epics`는(옛 이름이 여전히 `MIGRATED_RESOURCES` 키라) 정상 301 두 번(legacy→
 * renamed)을 거쳐 착지했지만, `/goals`(신 이름 그대로 오는 딥링크·북마크·검색결과)는 그
 * 표에 키가 없어 즉시 404 — 직통 Cloud Run 호스트 실측으로 발견됐다. 이 스토리(#1971) 착수
 * 당시엔 이미 `goals: []`가 표에 있어(별도 후속 수정으로 해소) 현재 데이터엔 위반이 없다 —
 * 하지만 그 수정 자체가 "리네임할 때마다 사람이 두 표를 손으로 동기화해야 한다"는 불변식을
 * 가드 없이 남겼다. 이 스크립트가 그 불변식을 CI에 고정한다.
 *
 * ── 스코프 밖(이 가드가 못 잡는 것) ─────────────────────────────────────────
 *   ㉠`RENAMED_RESOURCES`의 **키**(옛 이름)가 `MIGRATED_RESOURCES`에 있는지는 안 본다 —
 *     옛 이름은 리네임이 일어나기 전부터 이미 살아있던 리소스라 그 리소스를 만들 때 이미
 *     `MIGRATED_RESOURCES`에 등록됐을 것이 자연스러운 순서다(리네임이 «새로 만드는» 게
 *     아니라 «있던 것의 이름만 바꾸는» 것이므로, 키 쪽이 비는 사고는 실전례가 없다) — 값
 *     쪽(신 이름)만 실제로 두 번 사고가 난 자리(#2016)라 그쪽만 좁게 가드한다.
 *   ㉡`RETIRED_RESOURCES`의 값(폐기 후 목적지)은 검사 대상이 아니다 — `redirectRetiredResourcePath`도
 *     `segments[2]`(이미 ws/proj가 채워진 경로)만 보는 동형 함수라 원칙은 같지만, 그 목적지는
 *     항상 «이미 살아있는 다른 리소스»(예: `mockups: 'artifacts'`)라 정의상 이미
 *     `MIGRATED_RESOURCES`(또는 그 자체가 리소스 라우트) 어딘가에 등록돼 있다는 전제가 더
 *     강하다 — 이 스토리(#1971) AC가 명시한 «RENAMED 값→MIGRATED 키» 불변식 하나만 가드한다
 *     (PO 승인 스코프, 향후 실사고가 나면 별도 가드로 넓힌다).
 *   ㉢`MIGRATED_RESOURCES`의 서브패스 제외 목록(예: `docs: ['design-tokens']`)이 실제로
 *     존재하는 정적 페이지를 가리키는지는 안 본다 — 그 축은 `verify-no-orphan-resource-routes.ts`의
 *     라우트 실존 스캔과 겹치는 다른 관심사다.
 */
import { MIGRATED_RESOURCES, RENAMED_RESOURCES } from '../src/lib/legacy-resource-tables';

export function findRenamedTargetsMissingFromMigrated(
  renamed: Record<string, string>,
  migrated: Record<string, string[]>,
): string[] {
  const migratedKeys = new Set(Object.keys(migrated));
  return Object.values(renamed).filter((newName) => !migratedKeys.has(newName));
}

function main(): void {
  const missing = findRenamedTargetsMissingFromMigrated(RENAMED_RESOURCES, MIGRATED_RESOURCES);

  console.log(
    `[AC1] RENAMED_RESOURCES 값 ${Object.keys(RENAMED_RESOURCES).length}개 · ` +
      `MIGRATED_RESOURCES 키 ${Object.keys(MIGRATED_RESOURCES).length}개 대조`,
  );

  if (missing.length > 0) {
    console.log(
      `\n❌ RENAMED_RESOURCES 값이 MIGRATED_RESOURCES 키에 없다(bare ${missing
        .map((n) => `/${n}`)
        .join(', ')} 딥링크가 ws/proj를 못 채운 채 404) ${missing.length}건:`,
    );
    for (const name of missing) console.log(`  - "${name}" — legacy-resource-tables.ts의 MIGRATED_RESOURCES에 "${name}": [] 추가 필요`);
    console.log('\n→ #2016(epics→goals) 실사고와 동형. 리네임 시 RENAMED_RESOURCES와 MIGRATED_RESOURCES를 함께 갱신할 것.');
    process.exit(1);
  }

  console.log('OK: RENAMED_RESOURCES 값 전부 MIGRATED_RESOURCES 키에 있음(bare 신명 딥링크 404 없음)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
