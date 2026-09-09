import { describe, expect, it } from 'vitest';
import { NAV_GROUPS } from './nav-config';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';

// story #fddd0e6b(IA ⑦ 전체 메뉴, 유나 시안 ⑦ 판b 036c983a AC2) — 「무엇이 여기 있나」
// 한 줄은 NavItemConfig.descriptionKey가 SSOT다. nav-config.ts가 필수 필드로 강제하므로
// «값이 아예 없는» 회귀는 TypeScript가 컴파일 시점에 잡지만, «값은 있는데 그 i18n 키가
// ko/en 메시지 파일에서 빠진»(오타·키 삭제) 드리프트는 컴파일이 못 잡는다.
//
// story #5ead8723(가드·별건 ①) CHANGES(유나 디자인 게이트 지적, 2026-09-09) — 처음엔 이
// 실존 대조를 「중복 자」로 보고 전 화면 가드(verify-i18n-keys-exist.ts)로 이관하며 여기서
// 걷었으나(커밋 5a41e49cb), 그건 오판이었다: `more/page.tsx`의 소비는 `t(item.
// descriptionKey)`(변수 인자)라 AST 가드가 **구조적으로 실존을 못 본다**(리터럴이 아니라
// 동적 호출 버킷으로 카운트만 되고 끝 — 뮤테이션 확認: `nav.descOrgBriefing`을 ko·en 둘 다
// 지워도 그 가드는 GREEN이었다). 「카탈로그가 곧 키 목록인 자리」(desc 키가 데이터 자체로
// 존재하고 소비가 변수 인자로만 일어나는 자리)는 전 화면 가드의 사각지대라 국소 테스트가
// 여전히 맞는 자리 — 두 가드는 같은 것을 두 번 보는 게 아니라 서로 다른 축(리터럴 호출
// vs 데이터 카탈로그)을 나눠 본다. 그래서 이 실존 대조를 되살린다.
function allNavGroupItems() {
  return NAV_GROUPS.flatMap((g) => g.items);
}

describe('NAV_GROUPS descriptionKey 완전성 — story #fddd0e6b AC2', () => {
  // ⭐되돌리면 RED — NAV_GROUPS에 새 항목을 추가하며 descriptionKey를 빠뜨리면(또는 23개가
  // 아니게 늘거나 줄면) 이 수부터 어긋난다(첫 절 그라운딩이 23으로 확認한 값).
  it('항목이 정확히 23개다(첫 절 그라운딩 값 — now 2·dev 5·marketing 5·trust 2·knowledge 4·organization 4·settings 1)', () => {
    expect(allNavGroupItems()).toHaveLength(23);
  });

  it('⭐23개 전부가 descriptionKey를 갖는다(빈 문자열 아님) — board·inbox도 예약값을 가진다', () => {
    for (const item of allNavGroupItems()) {
      expect(item.descriptionKey, `${item.id}.descriptionKey`).toBeTruthy();
    }
  });

  // ⭐되돌리면 RED — ko.json에서 descOrgBriefing 같은 키 하나를 지우면(오타로 값이 사라지면)
  // 이 테스트가 잡는다. nav-config.ts 컴파일은 그 삭제를 못 본다(필드 자체는 여전히 채워진
  // 문자열 리터럴 'descOrgBriefing'이라 타입 에러가 안 남) — 그리고 전 화면 가드도 이 축은
  // 못 본다(more/page.tsx 소비가 `t(item.descriptionKey)`, 변수 인자라 AST가 리터럴로
  // 못 잡는다, story #5ead8723 CHANGES 유나 실측). 이 갭을 메우는 게 이 테스트의 존재 이유.
  it('⭐descriptionKey 23개 전부가 ko.json의 nav 네임스페이스에 실존한다(값 비어있지 않음)', () => {
    const nav = koMessages.nav as Record<string, string>;
    for (const item of allNavGroupItems()) {
      expect(nav[item.descriptionKey], `ko.nav.${item.descriptionKey}`).toBeTruthy();
    }
  });

  it('⭐descriptionKey 23개 전부가 en.json의 nav 네임스페이스에 실존한다(값 비어있지 않음)', () => {
    const nav = enMessages.nav as Record<string, string>;
    for (const item of allNavGroupItems()) {
      expect(nav[item.descriptionKey], `en.nav.${item.descriptionKey}`).toBeTruthy();
    }
  });

  // 양성대조 — 이 가드가 실제로 빠진 키를 구분해낼 수 있다는 것을 스스로 증명(항상 그린이
  // 아니라는 확認). 존재하지 않는 임의 키로 같은 조회를 하면 실패해야 정상이다.
  it('양성대조 — 존재하지 않는 키를 같은 방식으로 조회하면 falsy(가드가 실제로 구분한다)', () => {
    const nav = koMessages.nav as Record<string, string>;
    expect(nav['descNoSuchItemEver']).toBeFalsy();
  });
});
