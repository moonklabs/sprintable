import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './nav-config';

// story #fddd0e6b(IA ⑦ 전체 메뉴, 유나 시안 ⑦ 판b 036c983a AC2) — 「무엇이 여기 있나」
// 한 줄은 NavItemConfig.descriptionKey가 SSOT다. nav-config.ts가 필수 필드로 강제하므로
// «값이 아예 없는» 회귀는 TypeScript가 컴파일 시점에 잡는다.
//
// story #5ead8723(가드·별건 ①, 페드루 PO 決 2026-09-09) 후속 — 「그 i18n 키가 ko/en
// 메시지 파일에서 실존하나」는 이제 전 화면 가드(verify-i18n-keys-exist.ts)가 덮는다.
// 이 파일은 그 실존 대조를 걷고(중복 자 금지) 「NAV_GROUPS 계약 완전성」(항목 23개
// 전부가 descriptionKey 값을 가진다)만 남긴다 — nav-config.ts 자체를 그 계약의
// SSOT로 보는 국소 테스트.
function allNavGroupItems() {
  return NAV_GROUPS.flatMap((g) => g.items);
}

describe('NAV_GROUPS descriptionKey 완전성 — story #fddd0e6b AC2', () => {
  // ⭐되돌리면 RED — NAV_GROUPS에 새 항목을 추가하며 descriptionKey를 빠뜨리면(또는 23개가
  // 아니게 늘거나 줄면) 이 수부터 어긋난다(첫 절 그라운딩이 23으로 확認한 값).
  it('항목이 정확히 23개다(첫 절 그라운딩 값 — now 2·dev 5·marketing 5·trust 2·knowledge 4·organization 4·settings 1)', () => {
    expect(allNavGroupItems()).toHaveLength(23);
  });

  // ⭐되돌리면 RED — descriptionKey가 빈 문자열('')로 채워지면 타입은 통과하지만(string
  // 계약은 만족) 계약의 실질(「무엇이 여기 있나」 값이 있다)이 깨진다. TypeScript는 빈
  // 문자열도 유효한 string이라 이 축은 컴파일이 못 잡는다 — 이 테스트가 그 갭을 잡는다.
  it('⭐23개 전부가 descriptionKey를 갖는다(빈 문자열 아님) — board·inbox도 예약값을 가진다', () => {
    for (const item of allNavGroupItems()) {
      expect(item.descriptionKey, `${item.id}.descriptionKey`).toBeTruthy();
    }
  });
});
