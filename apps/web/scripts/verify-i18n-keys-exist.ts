/**
 * story #5ead8723(가드·별건 ①) — i18n 키 «실존» 가드. next-intl은 키를 못 찾으면 **키
 * 문자열을 그대로 화면에 그린다**(content/channel-posts/page.tsx:118 주석이 그 함정을
 * 이름으로 적어 둠) — 코드 낱말이 화면에 그대로 서는, 사용자가 보는 거짓의 가장 싼 형.
 * 기존 i18n 가드 셋(no-duplicate-i18n-keys·no-hanja-in-i18n·no-i18n-phrase-collision)은
 * «값»만 보고 «참조가 실존하나»는 안 본다 — 이 가드가 그 축 하나를 새로 채운다.
 *
 * ## 기전 — AST(verify-no-handrolled-card.ts·verify-no-hardcoded-korean-ui-text.ts와 동형,
 * 새 기전 발명 금지)
 * 정규식 줄 스캔이 아니라 TypeScript AST를 walk한다 — 주석은 AST 노드가 아니라 trivia라
 * 자동으로 안 걸린다(별도 주석 제거 로직 불요, 구조적으로 안전 — PO 스캐너의 오탐 2건
 * 「주석 속 t('key')」가 여기선 애초에 발생하지 않는다).
 *
 * ## 스캔 대상
 * `apps/web/src/**\/*.{ts,tsx}`(테스트 제외). 파일마다 한 번 top-down으로 walk하며:
 *
 * ① 네임스페이스 바인딩 — `const X = useTranslations('ns')` · `const X = useTranslations()`
 *   (루트, ns='') · `const X = await getTranslations('ns')` ·
 *   `const X = await getTranslations({ locale, namespace: 'ns' })`. 바인딩은 **마지막으로
 *   본 값이 이긴다**(변수명 재바인딩 — 한 파일 안 여러 컴포넌트가 각자 `const t =
 *   useTranslations(...)`를 갖는 실 패턴, 예: workcell.tsx 8회). top-down 단일 walk가
 *   선언을 그 아래 쓰임보다 항상 먼저 방문하므로(같은 서브트리 안에서 선언이 쓰임의
 *   형제 노드로 먼저 오는 실 코드 형태 — 별도 스코프 추적 없이도 이 순서 하나로 충분하다
 *   실측 확認, `let`/`var` 재대입·별칭 import 0건).
 *
 * ② 호출 — `X('key')` · `X.rich('key')` · `X.raw('key')` · `X.has('key')`(바인딩 var에서만
 *   — Set/Map의 `.has()` 등 무관 호출은 바인딩 필터링으로 자연 배제, 예:
 *   `HIDDEN_SETTINGS_TABS.has('workflow')`). 첫 인자가 **순수 문자열 리터럴**(`ts.
 *   isStringLiteral`)이면 리터럴 키 — `ns.key` 점 경로로 ko/en 실존 대조. 그 외(변수·
 *   템플릿 리터럴·삼항 등 — `ts.isStringLiteral`이 아닌 전부)는 **동적 호출로 카운트만
 *   하고 실패 안 시킨다**(「추출된 것만 순회」의 fails-silent를 「보이는 수」로 바꾼다 —
 *   [[feedback_a_guard_iterating_over_extracted_not_expected_fails_silent]]). 노-서브스티튜션
 *   템플릿(`` `plainKey` ``, 보간 0개라 값이 사실 정적인)도 문법적으로 템플릿이라 동적
 *   버킷 — 스펙 명시("동적 키: 변수·템플릿·삼항") 그대로, 뒤에 보간이 붙어도 재분류가
 *   안 생기게 일관되게 다룬다.
 *
 * ## ③ 번역자를 «파라미터»로 받는 함수(CHANGES, 유나 디자인 게이트 지적 2026-09-09)
 * `function C({ t }: { t: ReturnType<typeof useTranslations> })`류(hooks가 아니라 부모가
 * 만든 `t`를 물려받는 자식 컴포넌트/헬퍼 — 예: trust-utils.tsx의 `Translator` 타입 별칭,
 * insights-board-metric-cell.tsx의 `tContent`/`tBoard`)는 `useTranslations`/
 * `getTranslations` 호출 자체가 그 함수 안에 없어 바인딩이 안 잡혔다 — 그 결과 그 안의
 * 호출들이 리터럴·동적 어느 버킷에도 안 들고(`keyFromCall`이 `bindings.has()`에서 조용히
 * return) 자기완전성 항등식(리터럴+동적=총)마저 이 구멍을 못 드러냈다(항등식은 «세어진
 * 것들 사이»에서만 성립 — 실측 10파일·리터럴 79·동적 10건이 통째로 안 세어짐).
 *
 * 처방: 함수 파라미터의 타입 주석이 번역자 형이면 그 파라미터 이름을 바인딩으로 등록하되
 * 네임스페이스는 **모른다**(호출자가 어느 네임스페이스의 `t`를 넘겼는지는 이 파일 혼자서는
 * 알 수 없다 — 크로스파일 타입 추론은 안 한다) — 그래서 그 바인딩을 통한 호출은 리터럴이어도
 * **무조건 동적 버킷**(실존 검사 불가·「안 세어짐」0, 실존을 지어내지 않는다). 번역자 형은
 * 실측상 이 저장소에 정확히 두 축으로 나타난다(PO 1차 제안은 `k`/`messageKey`/`id`까지
 * 파라미터 이름을 넓히자는 것이었으나, 전수 스캔이 반증했다 — 아래 ㉣):
 *   ⓐ 「호출 가능한 값」 자체 — `ReturnType<typeof useTranslations>` 직접, 또는 그 형과
 *      구조적으로 같은 로컬 함수 타입 별칭(`type Translator = (key: string, values?) =>
 *      string`, trust-utils.tsx) — 파라미터에 직접 쓰이든(`t: Translator`) 프로퍼티로
 *      감싸이든(`{ t }: { t: ReturnType<...> }`) 동일하게 잡는다.
 *   ⓑ call-signature 인터페이스(`interface X { (key: string, values?): string }`) —
 *      derive-attention-queue.ts 등 6곳의 `*Translator` 관례(파일마다 로컬 재선언 — next-intl
 *      오버로드 제네릭과 결합 안 하려는 의도적 패턴). 멤버가 그 call-signature 하나뿐인
 *      인터페이스만 번역자로 본다(프로퍼티가 섞이면 다른 개념일 수 있어 제외).
 * ⓐⓑ 둘 다 **파라미터 이름이 정확히 `key`, 첫 인자 타입이 `string`, (반환 타입 주석이
 * 있다면) 그것도 `string`**이어야 매치한다 — 실측(전수 스캔): 이 세 조건을 만족하는 함수형/
 * call-signature는 이 저장소에 40여 곳 있고 전부 `key`(그 안의 최상위 바인딩 변수명은
 * `t`/`tContent`/`tOutcome` 등 다양) — `k`/`messageKey`는 0건, `id`는 있으나(예:
 * `resolveName?: (id: string) => string`) 전부 반환 타입이 `string | null` 등 정확히
 * `string`이 아니거나 번역자와 무관한 이름-리졸버라 이름 조건을 넓히면 오히려 오탐이 된다
 * (PO 1차 grounding 정정 — CHANGES 재정정에 반영).
 *
 * ## ⑤⑥ 커스텀 훅이 반환한 번역자(CHANGES 재재지적, 유나 2026-09-09)
 * ③이 다루는 「함수 파라미터로 받는 번역자」와 겹치지 않는 다른 소비 형 — 커스텀 훅
 * (`useAccountSwitcher`)이 내부에서 `useTranslations`를 불러 그 결과(`t`/`tc`)를 반환
 * 객체에 담아 내보내면, 소비 파일 쪽에는 그 훅 호출 자체가 useTranslations/getTranslations가
 * 아니라서(다른 파일 안에 있다) 바인딩이 전혀 안 잡혔다(profile-menu.tsx: totalCallCount
 * 1 — 나머지 8곳이 안 세어짐). 두 형:
 *   ⑤ 프로퍼티 접근 그대로 호출(`acc.t('key')`/`acc.tc('key')`, context-switcher-chip.tsx
 *      8곳) — `acc`는 훅의 전체 반환 객체를 들고 있을 뿐 그 자체가 번역자가 아니다.
 *   ⑥ 훅 반환값을 구조분해(`const { t, tc } = useAccountSwitcher(...)`, profile-menu.tsx
 *      8곳) — initializer가 useTranslations/getTranslations가 **아닌** 임의 호출이다.
 * ⑤⑥ 둘 다 프로퍼티/로컬 이름이 **정확히 `t` 또는 `tc`**일 때만 인정한다(③의 「이름
 * 하나만 정밀하게」 원칙과 동형 — 전수 스캔: 이 두 이름 외 프로퍼티 접근/임의-호출
 * 구조분해로 나타나는 형은 이 저장소에 0건, `useAccountSwitcher` 훅 하나뿐). 인정되면
 * ③과 동일하게 네임스페이스를 모르니 **무조건 동적 버킷**.
 *
 * ## A″ — t() 계열 호출 «밖»의 리터럴(story #3765, 3757-b)
 * 위 ①②③⑤⑥은 전부 "번역자를 통해 실제로 호출되는 자리"만 본다 — 그런데 리터럴 키
 * 이름이 t() 호출의 인자가 «아니라» 다른 함수의 인자로, 또는 조회 테이블의 값으로만
 * 코드에 등장하고 그 함수/테이블이 내부에서 그 값을 변수로 `t(변수)`하는 형(간접
 * fallback-key 전달)은 위 신호 어디에도 안 걸린다(story #3757 삭제 작업 중 실물로 발견
 * — `invite.acceptFailed`·`dashboard.ccGateType*` 13건, #4112). 두 하위형:
 *   (A) 번역자 co-argument — `inviteErrorMessage(tInvite, code, 'acceptFailed')`처럼
 *       이미 바인딩된 번역자 변수를 다른 함수 호출의 인자로 넘기면서 리터럴 문자열도
 *       같은 호출의 다른 인자로 넘긴다. 번역자의 ns가 알려지면(예: `tInvite`) 정밀한
 *       전체경로(`invite.acceptFailed`)를 만든다.
 *   (B) `Record<string, string>` 조회 테이블 값 — `gate-type-label.ts`의
 *       `GATE_TYPE_LABEL_KEYS`처럼 리터럴이 테이블 «값»으로만 존재하고 그 테이블을
 *       나중에 `t(table[x])`로 소비한다. 테이블이 선언된 파일이 ns를 하나 이상 열면
 *       (useTranslations 리터럴) 그 ns(들)로 전체경로를 좁힌다(동음이의 다른 ns를
 *       안 건드리는 핵심 장치 — 예: `epic-status-transition.tsx`의 `LABEL_KEY`는
 *       그 파일이 'goals'만 여니 `goals.statusActive`만 내고 `dashboard.statusActive`는
 *       안 건드린다). 파일이 ns를 하나도 안 열면(gate-type-label.ts처럼 t를 파라미터로만
 *       받는 순수 헬퍼) ns를 알 방법이 구조적으로 없어 관대한 낱말 축으로만 떨어진다.
 * 정밀도 원칙: ns를 알 수 있으면 반드시 전체경로로 좁힌다 — 관대한 낱말 축은 최후
 * 수단이다(동음이의 오탐 방지, `ScanResult.indirectLookupRefs`/`indirectLookupWords`
 * 필드 docstring 참조).
 *
 * ## 못 잡는 것(⚠️)
 *   ㉠ 네임스페이스 자체가 동적(`useTranslations(nsVar)`)인 바인딩은 등록하지 않는다 —
 *      그 var를 통한 이후 호출은 바인딩 미매칭이라 리터럴도 동적도 아닌 채로 조용히
 *      안 잡힌다. 실측 0건(모든 useTranslations/getTranslations 인자가 리터럴이거나
 *      없음) — 생기면 별도 축.
 *   ㉡ 스코프가 실제로 갈리는데(예: 조건부 렌더 두 분기가 다른 네임스페이스를 같은 var
 *      이름으로) 이 파일이 상정하는 「마지막 선언이 이긴다」 단순 모델을 벗어나는 코드는
 *      오분류 가능 — 실측상 이 저장소에 이런 형은 없다(전부 함수 스코프당 정확히 1개
 *      선언).
 *   ㉢ `.d.ts`·타입 전용 파일은 스캔하되 실질 호출이 없어 자연히 기여 0.
 *   ㉣ 번역자 파라미터 이름이 `key`가 아닌 다른 이름(`k`·`messageKey` 등)이면 여전히
 *      안 잡힌다 — 실측 0건(이 저장소의 모든 실 번역자 call-signature/함수형이 `key`를
 *      쓴다). 생기면 이름 조건을 그 하나만 추가(무분별한 확장은 오탐, 위 ⓐⓑ 실측 참조).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type MessageNode = string | { [key: string]: MessageNode };

export interface KeyRef {
  file: string;
  line: number;
  fullKey: string;
}

export interface ScanResult {
  literalRefs: KeyRef[];
  dynamicCount: number;
  totalCallCount: number;
  filesWithBindings: number;
  // story #3757(별건 ⑤ 후속) — 「동적 호출이 하나라도 있는 네임스페이스」 집합. ns가
  // 알려진(문자열) 바인딩을 통한 동적 호출만 담는다 — ③/⑤/⑥(번역자 파라미터·훅 반환)의
  // unknown-ns(null) 동적 호출은 애초에 「어느 ns를 held back할지」를 모르므로 여기 안
  // 들어간다(그쪽은 개별 낱말 축 A′로 별도 다룸, 이 필드와는 다른 축).
  dynamicNamespaces: Set<string>;
  // story #3757 — 층 A′(유나 정의): unknown-ns(③/⑤/⑥ 번역자 파라미터/훅 반환) 바인딩을
  // 통한 호출이라도 인자가 여전히 문자열 리터럴이면(가장 흔한 실 패턴 — member-display.ts의
  // `memberDisplayLabel(name, t)`가 `t('memberUnnamed')`를 리터럴로 부른다), 정확한
  // namespace.key 전체경로는 못 지어도 그 "낱말"(마지막 세그먼트) 자체는 안다 — 그 낱말이
  // «어느 네임스페이스 밑에도» 죽었다고 오판되지 않게(과소살해 방지, 정확한 ns를 못 좁히는
  // 대가로 관대하게 살린다). ko/en 어느 네임스페이스의 말단이든 이 집합의 문자열과 정확히
  // 같으면 「죽지 않았다」로 본다 — 죽은-키 판정(이 파일 밖 소비처)이 쓰는 재료.
  unknownNsLiteralWords: Set<string>;
  // story #3765(3757-b, 되살린 14의 클래스 자체를 자에 코드화) — 층 A″(유나 정의).
  // 「t() 계열 호출 밖의 다른 문자열 리터럴이 리프 키 경로/낱말과 일치 = 살아 있음」
  // 두 구조적 하위형:
  //   (A) 「번역자 co-argument」 — 이미 바인딩된 번역자 변수를 그 t() 호출 자체가
  //       아니라 다른 함수 호출의 인자로 «같이» 넘기면서, 그 호출의 다른 인자로
  //       리터럴 문자열도 같이 넘기는 형(`inviteErrorMessage(tInvite, code,
  //       'acceptFailed')` — invite-accept-client.tsx). 번역자의 ns가 알려져 있으면
  //       (`tInvite`처럼) 정밀한 전체경로(`invite.acceptFailed`)를 만든다 — «어느
  //       호출을 통해 이 리터럴이 실제로 그 ns의 t()에 닿을지»를 이 파일 혼자 증명할
  //       순 없지만, 번역자 자체가 그 호출의 인자로 명시적으로 전달됐다는 사실 자체가
  //       충분히 강한 신호(호출 그래프 추론 없이도 같은 콜 표현식 안에서 구문적으로
  //       확認됨).
  //   (B) 「Record<string,string> 조회 테이블 값」 — `const X: Record<string,string> =
  //       {a: 'ccGateTypeQa', ...}`(gate-type-label.ts) 형. 테이블이 선언된 파일
  //       자신이 어느 ns를 여는지(useTranslations 리터럴) 알면 그 ns(들)로 전체경로를
  //       만들고(예: epic-status-transition.tsx의 `LABEL_KEY: Record<string,string>`은
  //       그 파일이 'goals'를 열므로 `goals.statusActive`만 만든다 — «dashboard.
  //       statusActive»라는 동음이의 다른 ns 키는 안 건드린다), 파일 자신이 ns를
  //       하나도 안 열면(gate-type-label.ts처럼 t를 파라미터로만 받는 헬퍼) ns를 알
  //       방법이 없으니 관대한 낱말 축(indirectLookupWords)으로만 떨어뜨린다.
  // 정밀도 원칙: ns를 알 수 있으면 반드시 전체경로로 좁힌다(관대한 낱말 축은 ns를 알
  // 방법이 구조적으로 없을 때만 최후 수단) — 동음이의 9건(billing.grandfathered/keep/
  // via·common.next/unassigned·dashboard.statusActive·sprints.create·
  // activityLog.description·invite.description)이 이 축으로 잘못 되살아나지 않게
  // 하는 핵심 장치. 9건은 애초에 (A)의 co-argument 조건도(번역자와 같이 안 넘어감)
  // (B)의 Record<string,string> 초기화식 조건도(타입 유니언·삼항 비교·JSDoc 주석·
  // JSX 속성·배열 리터럴 원소일 뿐 object literal의 Record<string,string> 프로퍼티
  // 값이 아님) 구조적으로 만족하지 않는다 — 별도 deny-list 불요, 형 자체가 갈린다.
  indirectLookupRefs: KeyRef[];
  indirectLookupWords: Set<string>;
}

const TRANSLATION_METHODS = new Set(['rich', 'raw', 'has']);

// ⑤⑥ CHANGES(유나 디자인 게이트 재지적 2026-09-09) — 커스텀 훅이 `useTranslations`를
// 내부에서 호출하고 그 결과(`t`/`tc`)를 반환하면, 소비 파일 입장에선 그 반환값이 「이
// 파일 안에서 useTranslations를 직접 부르지 않은 번역자」가 된다(③ 번역자-파라미터와
// 같은 처지 — 네임스페이스가 다른 파일 안에 있어 이 파일 혼자서는 모른다). 실측(전수
// 스캔): 이 정확한 두 이름(`t`/`tc`)으로 나타나는 두 형뿐이다(context-switcher-chip.tsx
// 프로퍼티 접근 8곳·profile-menu.tsx 구조분해 8곳, useAccountSwitcher 훅 하나 — 다른
// 이름/다른 훅 0건) — 그래서 ③과 같은 정밀도 원칙(오탐 방지 위해 정확한 이름만)을
// 여기도 유지한다: 이름이 정확히 `t`/`tc`일 때만 인정.
const HOOK_RETURNED_TRANSLATOR_NAMES = new Set(['t', 'tc']);

function namespaceFromArgs(args: readonly ts.Expression[]): string | null {
  if (args.length === 0) return '';
  const first = args[0];
  if (ts.isStringLiteral(first)) return first.text;
  if (ts.isObjectLiteralExpression(first)) {
    for (const prop of first.properties) {
      if (
        ts.isPropertyAssignment(prop)
        && ts.isIdentifier(prop.name)
        && prop.name.text === 'namespace'
        && ts.isStringLiteral(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
    return null;
  }
  return null;
}

// ③ 「직접 ReturnType<typeof useTranslations>」 구조 판정.
function isDirectTranslatorReturnType(t: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName) || t.typeName.text !== 'ReturnType') {
    return false;
  }
  const arg = t.typeArguments?.[0];
  return !!arg && ts.isTypeQueryNode(arg) && ts.isIdentifier(arg.exprName) && arg.exprName.text === 'useTranslations';
}

// ③ CHANGES 정정(페드루 PO, 유나 재실측 2026-09-09) — 파라미터 «이름»만으로 번역자를 잡으면
// 무관 콜백(첫 인자가 우연히 `key`라는 이름이지만 string이 아니거나 시그니처가 다른 것 —
// 실측 37파일·223호출 오탐 위험)이 섞인다. 그래서 이름뿐 아니라 **첫 파라미터의 타입 주석이
// `string`, 반환 타입 주석이 있다면 그것도 `string`**인지까지 구조로 확인한다(둘째 인자
// `values?`는 선택이라 형만 다양해도 무관 — 첫 인자·반환만 계약의 핵심).
//
// PO는 `ts.Program`+`checker.getTypeAtLocation`(의미론적 타입체크)을 제안했으나, 이 저장소의
// 다른 모든 가드(verify-no-handrolled-card.ts 등)가 Program 없는 단일 소스파일 AST walk이고
// 이 가드 자신의 모듈 docstring도 그 관례를 "새 기전 발명 금지"로 명시한다 — 여기서 실제로
// 필요한 건 「타입 검사」가 아니라 「이 정확한 어노테이션 문구가 있나」이므로(전부 로컬
// 리터럴 타입 주석, 크로스파일 추론 불요) 구문 검사로 동등한 정밀도를 얻을 수 있다(오탐
// 조건도 동일하게 닫힌다) — Program 구성 비용·이 파일군의 유일한 새 기전을 들이지 않는다.
function isStringKeywordType(t: ts.TypeNode): boolean {
  return t.kind === ts.SyntaxKind.StringKeyword;
}

function isTranslatorCallLikeShape(parameters: readonly ts.ParameterDeclaration[], returnType: ts.TypeNode | undefined): boolean {
  const first = parameters[0];
  if (!first || !ts.isIdentifier(first.name) || first.name.text !== 'key') return false;
  if (!first.type || !isStringKeywordType(first.type)) return false;
  if (returnType && !isStringKeywordType(returnType)) return false;
  return true;
}

// ③ 「(key: string, ...) => string」 함수형 — trust-utils.tsx의 `Translator` 타입 별칭.
function isTranslatorFunctionShape(t: ts.TypeNode): boolean {
  if (!ts.isFunctionTypeNode(t)) return false;
  return isTranslatorCallLikeShape(t.parameters, t.type);
}

// ③ call-signature 인터페이스(`interface X { (key: string, values?): string }`) —
// derive-attention-queue.ts/command-palette-actions.ts/org-briefing derive-*.ts 6곳의
// `*Translator` 관례(파일마다 로컬 재선언 — next-intl 오버로드 제네릭과 결합 안 하려는
// 의도적 패턴, derive-attention-queue.ts 주석). 멤버가 정확히 하나의 call-signature뿐이고
// 다른 멤버가 없어야 한다(순수 호출-형만 번역자로 본다 — 프로퍼티가 섞인 인터페이스는
// «번역자+α» 다른 개념일 수 있어 오분류 방지).
function interfaceCallSignatureShape(node: ts.InterfaceDeclaration): ts.CallSignatureDeclaration | null {
  if (node.members.length !== 1) return null;
  const only = node.members[0];
  return ts.isCallSignatureDeclaration(only) ? only : null;
}

// ⓑ story #3765 — `Record<string, string>` 정확히 그 두 타입인자(둘 다 string 키워드)인
// 타입 참조 판정. `Record<GoalStatus, string>`처럼 첫 타입인자가 string이 아니면 매치
// 안 함(그 경우는 이미 층 B — 그 ns 자체가 동적 호출로 held-back되는 케이스가 실측상
// 전부라 A″가 안 다뤄도 안전, `goals.statusActive` 실측 확認).
function isRecordStringStringType(t: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName) || t.typeName.text !== 'Record') return false;
  const args = t.typeArguments;
  return !!args && args.length === 2 && isStringKeywordType(args[0]) && isStringKeywordType(args[1]);
}

function isTranslatorTypeStructural(t: ts.TypeNode): boolean {
  return isDirectTranslatorReturnType(t) || isTranslatorFunctionShape(t);
}

function isTranslatorParamType(t: ts.TypeNode, aliasNames: Set<string>): boolean {
  if (isTranslatorTypeStructural(t)) return true;
  return ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && aliasNames.has(t.typeName.text);
}

// ③ 타입 리터럴(인라인 `{ t: ReturnType<...> }` 또는 `interface X { t: Translator }`) 멤버
// 중 번역자 형인 프로퍼티 이름만 뽑는다 — apply-recipe-dialog.tsx(인라인 ReturnType)·
// facebook-page-select-card.tsx/insights-board-metric-cell.tsx(named interface,
// ReturnType 직접)·trust-utils.tsx(named interface 멤버가 로컬 별칭 `Translator`를 참조)
// 전부 이 형(구조분해 파라미터 + 번역자 프로퍼티). aliasNames는 멤버 타입이 «별칭
// 참조」일 때도 판정하려고 받는다(isTranslatorParamType과 같은 축).
function translatorPropNamesInMembers(members: readonly ts.TypeElement[], aliasNames: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    if (
      ts.isPropertySignature(member) && member.type
      && ts.isIdentifier(member.name) && isTranslatorParamType(member.type, aliasNames)
    ) {
      names.add(member.name.text);
    }
  }
  return names;
}

// ③ 파일 하나에서 「번역자와 구조적으로 같은」 로컬 타입을 전부 모은다(선언 순서 무관 —
// 이름으로 참조되니 본 walk 前에 한 번 훑는다). 두 단계로 나눈다 — propNamesByType가
// 멤버 타입을 aliasNames로 판정해야 하므로(trust-utils.tsx: interface 멤버가 `Translator`
// 별칭을 참조) aliasNames를 먼저 완성한 뒤에 propNamesByType을 계산한다.
//   aliasNames — 타입 자체가 번역자 형인 별칭(단순 파라미터: `t: Translator`).
//   propNamesByType — 타입(별칭/interface)이 번역자 프로퍼티를 담은 객체형일 때, 그
//     프로퍼티 이름 집합(구조분해 파라미터: `{ t }: FooProps`).
function collectTranslatorTypeInfo(sf: ts.SourceFile): {
  aliasNames: Set<string>;
  propNamesByType: Map<string, Set<string>>;
} {
  const aliasNames = new Set<string>();
  function visitAliases(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && isTranslatorTypeStructural(node.type)) {
      aliasNames.add(node.name.text);
    }
    // call-signature interface — 함수 타입 별칭과 동형(둘 다 「호출하면 string」인 값).
    if (ts.isInterfaceDeclaration(node)) {
      const callSig = interfaceCallSignatureShape(node);
      if (callSig && isTranslatorCallLikeShape(callSig.parameters, callSig.type)) {
        aliasNames.add(node.name.text);
      }
    }
    node.forEachChild(visitAliases);
  }
  visitAliases(sf);

  const propNamesByType = new Map<string, Set<string>>();
  function visitProps(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      const props = translatorPropNamesInMembers(node.type.members, aliasNames);
      if (props.size > 0) propNamesByType.set(node.name.text, props);
    }
    if (ts.isInterfaceDeclaration(node)) {
      const props = translatorPropNamesInMembers(node.members, aliasNames);
      if (props.size > 0) propNamesByType.set(node.name.text, props);
    }
    node.forEachChild(visitProps);
  }
  visitProps(sf);

  return { aliasNames, propNamesByType };
}

// ③ 구조분해 파라미터(`{ t, tc }: FooProps` 또는 `{ t }: { t: ReturnType<...> }`)의 타입에서
// 번역자 프로퍼티 이름 집합을 얻는다 — 인라인 타입 리터럴은 그 자리서, named 타입은
// propNamesByType로 조회.
function translatorPropNamesOfParamType(
  t: ts.TypeNode, propNamesByType: Map<string, Set<string>>, aliasNames: Set<string>,
): Set<string> {
  if (ts.isTypeLiteralNode(t)) return translatorPropNamesInMembers(t.members, aliasNames);
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
    return propNamesByType.get(t.typeName.text) ?? new Set();
  }
  return new Set();
}

// 파일 하나를 top-down walk — 바인딩(varName→ns)은 「마지막 선언이 이긴다」(모듈 docstring
// ① 참조). 호출은 그 시점까지의 바인딩 상태로 판정한다. ns 값 `null`은 ③(번역자
// 파라미터) — 바인딩은 있으나 네임스페이스를 몰라 그 호출은 항상 동적 버킷.
export function scanFileContent(content: string, file: string): {
  literalRefs: KeyRef[]; dynamicCount: number; totalCallCount: number; hasBindings: boolean;
  dynamicNamespaces: Set<string>; unknownNsLiteralWords: Set<string>;
  indirectLookupRefs: KeyRef[]; indirectLookupWords: Set<string>;
} {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    throw new Error(
      `FAIL: ${file} — ts.createSourceFile의 parseDiagnostics 필드가 사라짐(TS 내부 API 변경 의심) — ` +
        '이 가드의 전제(파싱 실패를 스스로 감지할 수 있다는 전제)가 깨졌다(story #2710 동형).',
    );
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `FAIL: ${file} 파싱 실패(${parseDiagnostics.length}건) — 이 가드가 이 파일의 i18n 호출을 ` +
        `못 읽는다(재료 소실을 조용한 통과로 두지 않는다, story #2710 AC4 동형): ` +
        parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; '),
    );
  }

  // string = 알려진 네임스페이스(리터럴 검사 가능). null = ③ 번역자 파라미터(바인딩은
  // 있으나 네임스페이스를 몰라 그 호출은 항상 동적 버킷).
  const bindings = new Map<string, string | null>();
  const { aliasNames: translatorAliasNames, propNamesByType } = collectTranslatorTypeInfo(sf);
  const literalRefs: KeyRef[] = [];
  let dynamicCount = 0;
  let totalCallCount = 0;
  const dynamicNamespaces = new Set<string>();
  const unknownNsLiteralWords = new Set<string>();
  // story #3765(층 A″) — 원재료만 이 파일 하나의 단일 walk 안에서 같이 모은다(별도
  // 전체-트리 재순회 2회를 안 하려는 성능 처방, 페드루 PO 지적 2026-09-10 — CI가
  // A″ 도입 뒤 실 소스 전수 스캔 테스트에서 5s 타임아웃을 침). 판정(바인딩이 알려진
  // ns인지/unknown-ns인지, 파일이 어떤 ns들을 여는지)은 여전히 walk 완결 뒤(아래)
  // 한다 — bindings가 이 시점엔 아직 다 안 채워졌을 수 있어서(변수 재선언 등).
  const translatorCoArgCandidates: { boundVar: string; literal: string; line: number }[] = [];
  const recordTableCandidates: { value: string; line: number }[] = [];

  function registerBindingFromInitializer(varName: string, initRaw: ts.Expression): void {
    const init = ts.isAwaitExpression(initRaw) ? initRaw.expression : initRaw;
    if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return;
    const callee = init.expression.text;
    if (callee !== 'useTranslations' && callee !== 'getTranslations') return;
    const ns = namespaceFromArgs(init.arguments);
    if (ns === null) return; // ㉠ 동적 네임스페이스 — 바인딩 등록 안 함.
    bindings.set(varName, ns);
  }

  function countCallWithNamespace(node: ts.CallExpression, ns: string | null): void {
    totalCallCount += 1;
    const arg = node.arguments[0];
    if (ns !== null && arg && ts.isStringLiteral(arg)) {
      const fullKey = ns ? `${ns}.${arg.text}` : arg.text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      literalRefs.push({ file, line, fullKey });
    } else {
      dynamicCount += 1;
      if (ns !== null) {
        dynamicNamespaces.add(ns);
      } else if (arg && ts.isStringLiteral(arg)) {
        unknownNsLiteralWords.add(arg.text);
      }
    }
  }

  function keyFromCall(node: ts.CallExpression, varName: string): void {
    if (!bindings.has(varName)) return;
    countCallWithNamespace(node, bindings.get(varName)!);
  }

  function walk(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        registerBindingFromInitializer(node.name.text, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        // ⑥ 커스텀 훅이 반환한 번역자 구조분해(`const { t, tc } = useAccountSwitcher(...)`)
        // — 훅 내부에서 useTranslations를 부르므로 initializer 자체는 useTranslations/
        // getTranslations 호출이 아니다(어떤 호출이든 무관) — 로컬 이름이 정확히
        // HOOK_RETURNED_TRANSLATOR_NAMES(t/tc)일 때만 unknown-ns(null) 바인딩.
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const propKey = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          if (HOOK_RETURNED_TRANSLATOR_NAMES.has(propKey)) {
            bindings.set(element.name.text, null);
          }
        }
      }
    }
    // ⑤ 객체 프로퍼티 접근(`acc.t('key')`/`acc.tc('key')`) — ⑥과 쌍을 이루는 다른 소비
    // 형(구조분해로 로컬 변수를 안 만들고 훅 반환 객체를 들고 있다가 프로퍼티로 바로
    // 호출). `acc` 자체는 바인딩 대상이 아니고(번역자가 아니라 그 훅의 전체 반환 객체),
    // 프로퍼티 이름이 정확히 t/tc일 때만 그 호출 자체를 unknown-ns로 즉시 카운트한다
    // (사전 바인딩 등록 불요 — 이름 매치 자체가 신호).
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.name)
      && HOOK_RETURNED_TRANSLATOR_NAMES.has(node.expression.name.text)
    ) {
      countCallWithNamespace(node, null);
    }
    // ③ 번역자 파라미터 — 네임스페이스는 모르니 null 바인딩(호출은 항상 동적으로 카운트,
    // 「안 세어짐」을 없앤다). 단순 이름(`t: Translator`)과 구조분해(`{ t }: FooProps`)
    // 둘 다 다룬다.
    if (ts.isParameter(node) && node.type) {
      if (ts.isIdentifier(node.name)) {
        if (isTranslatorParamType(node.type, translatorAliasNames)) {
          bindings.set(node.name.text, null);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        const translatorProps = translatorPropNamesOfParamType(node.type, propNamesByType, translatorAliasNames);
        if (translatorProps.size > 0) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue; // 중첩 구조분해는 스코프 밖.
            const propKey = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            if (translatorProps.has(propKey)) {
              bindings.set(element.name.text, null);
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        keyFromCall(node, callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && ts.isIdentifier(callee.name)
        && TRANSLATION_METHODS.has(callee.name.text)
      ) {
        keyFromCall(node, callee.expression.text);
      }
      // story #3765(층 A″ 조건 A) — 「번역자 co-argument」 원재료를 같은 방문에서 같이
      // 뽑는다(별도 전체-트리 재순회 없음). 판정은 walk 완결 뒤(bindings 완결 후).
      const idArgs = node.arguments.filter((a): a is ts.Identifier => ts.isIdentifier(a));
      if (idArgs.length > 0) {
        const litArgs = node.arguments.filter((a): a is ts.StringLiteral => ts.isStringLiteral(a));
        if (litArgs.length > 0) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          for (const idArg of idArgs) {
            for (const lit of litArgs) translatorCoArgCandidates.push({ boundVar: idArg.text, literal: lit.text, line });
          }
        }
      }
    }
    // story #3765(층 A″ 조건 B) — 「Record<string,string> 조회 테이블 값」 원재료도 같은
    // 방문에서 같이 뽑는다. ns 스코핑 판정은 walk 완결 뒤.
    if (
      ts.isVariableDeclaration(node) && node.type && isRecordStringStringType(node.type)
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.initializer)) {
          const line = sf.getLineAndCharacterOfPosition(prop.initializer.getStart(sf)).line + 1;
          recordTableCandidates.push({ value: prop.initializer.text, line });
        }
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);

  // story #3765(층 A″) — bindings가 이제 완결됐으니(파일 전체 walk 끝) 조건(A)/(B) 원재료를
  // 판정한다. ns를 알 수 있으면 반드시 전체경로로 좁힌다(관대한 낱말 축은 ns를 알 방법이
  // 구조적으로 없을 때만 — 모듈 docstring 참조).
  const indirectLookupRefs: KeyRef[] = [];
  const indirectLookupWords = new Set<string>();

  for (const { boundVar, literal, line } of translatorCoArgCandidates) {
    if (!bindings.has(boundVar)) continue;
    const ns = bindings.get(boundVar)!;
    if (ns !== null) {
      indirectLookupRefs.push({ file, line, fullKey: ns ? `${ns}.${literal}` : literal });
    } else {
      indirectLookupWords.add(literal);
    }
  }

  const knownNamespacesInFile = new Set<string>();
  for (const ns of bindings.values()) {
    if (ns !== null) knownNamespacesInFile.add(ns);
  }
  for (const { value, line } of recordTableCandidates) {
    if (knownNamespacesInFile.size > 0) {
      for (const ns of knownNamespacesInFile) {
        indirectLookupRefs.push({ file, line, fullKey: ns ? `${ns}.${value}` : value });
      }
    } else {
      indirectLookupWords.add(value);
    }
  }

  return {
    literalRefs, dynamicCount, totalCallCount, hasBindings: bindings.size > 0,
    dynamicNamespaces, unknownNsLiteralWords,
    indirectLookupRefs, indirectLookupWords,
  };
}

const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;
const MIN_EXPECTED_FILES = 1000;

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkDir(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

// story #3757 — minExpectedFiles 오버라이드 가능(기본값=실 저장소 기준 MIN_EXPECTED_FILES).
// 임시 픽스처 디렉터리(파일 수십 개 미만)로 이 함수를 끝까지 돌리는 통합 테스트가
// 이 자기방어 체크에 걸리지 않게 여는 것 — 실 저장소 스캔(인자 생략)의 안전판은 그대로.
export function scanRepo(srcRoot: string, minExpectedFiles: number = MIN_EXPECTED_FILES): ScanResult {
  const files: string[] = [];
  walkDir(srcRoot, files);
  if (files.length < minExpectedFiles) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const literalRefs: KeyRef[] = [];
  let dynamicCount = 0;
  let totalCallCount = 0;
  let filesWithBindings = 0;
  const dynamicNamespaces = new Set<string>();
  const unknownNsLiteralWords = new Set<string>();
  const indirectLookupRefs: KeyRef[] = [];
  const indirectLookupWords = new Set<string>();
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    const result = scanFileContent(content, rel);
    literalRefs.push(...result.literalRefs);
    dynamicCount += result.dynamicCount;
    totalCallCount += result.totalCallCount;
    if (result.hasBindings) filesWithBindings += 1;
    for (const ns of result.dynamicNamespaces) dynamicNamespaces.add(ns);
    for (const w of result.unknownNsLiteralWords) unknownNsLiteralWords.add(w);
    indirectLookupRefs.push(...result.indirectLookupRefs);
    for (const w of result.indirectLookupWords) indirectLookupWords.add(w);
  }
  return {
    literalRefs, dynamicCount, totalCallCount, filesWithBindings,
    dynamicNamespaces, unknownNsLiteralWords,
    indirectLookupRefs, indirectLookupWords,
  };
}

// story #5ead8723 AC1/AC2 — 점 경로를 메시지 트리에서 내려가 **말단**(string)까지 도달해야
// "존재"다. 도중에 끊기거나(중간 키 부재) 말단이 object로 남으면(경로가 branch에서 멈춤)
// 모두 부재로 판정한다.
export function resolveMessageKey(messages: MessageNode, dottedKey: string): boolean {
  const segments = dottedKey.split('.');
  let cur: MessageNode = messages;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return typeof cur === 'string';
}

// ko↔en 말단 키 집합(전체 경로, dot-joined) — 양방향 차집합 0 판정용.
export function collectLeafKeys(messages: MessageNode, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (typeof messages === 'string') {
    out.add(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(messages)) {
    const next = prefix ? `${prefix}.${k}` : k;
    for (const leaf of collectLeafKeys(v, next)) out.add(leaf);
  }
  return out;
}

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

function main(): number {
  const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8')) as MessageNode;
  const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8')) as MessageNode;
  const result = scanRepo(SRC_ROOT);

  const missingKo = result.literalRefs.filter((r) => !resolveMessageKey(koMessages, r.fullKey));
  const missingEn = result.literalRefs.filter((r) => !resolveMessageKey(enMessages, r.fullKey));

  const koLeaves = collectLeafKeys(koMessages);
  const enLeaves = collectLeafKeys(enMessages);
  const koOnly = [...koLeaves].filter((k) => !enLeaves.has(k));
  const enOnly = [...enLeaves].filter((k) => !koLeaves.has(k));

  console.log(
    `[가드] i18n 키 실존 스캔 — 바인딩 있는 파일 ${result.filesWithBindings}개 · ` +
      `리터럴 호출 ${result.literalRefs.length}건 · 동적 호출 ${result.dynamicCount}건 ` +
      `(총 호출 ${result.totalCallCount}건 — 리터럴+동적=총) · ko 말단 ${koLeaves.size} · en 말단 ${enLeaves.size}`,
  );

  let failed = false;

  if (missingKo.length > 0) {
    failed = true;
    console.error(`\nFAIL: ko.json에 없는 키 ${missingKo.length}건:`);
    for (const r of missingKo) console.error(`  ${r.file}:${r.line} "${r.fullKey}"`);
  }
  if (missingEn.length > 0) {
    failed = true;
    console.error(`\nFAIL: en.json에 없는 키 ${missingEn.length}건:`);
    for (const r of missingEn) console.error(`  ${r.file}:${r.line} "${r.fullKey}"`);
  }
  if (koOnly.length > 0) {
    failed = true;
    console.error(`\nFAIL: ko에만 있고 en엔 없는 말단 키 ${koOnly.length}건:`);
    for (const k of koOnly) console.error(`  ${k}`);
  }
  if (enOnly.length > 0) {
    failed = true;
    console.error(`\nFAIL: en에만 있고 ko엔 없는 말단 키 ${enOnly.length}건:`);
    for (const k of enOnly) console.error(`  ${k}`);
  }

  if (failed) {
    console.error(
      '\n→ 코드가 참조하는 i18n 키는 ko/en 둘 다에 값(말단 문자열)으로 있어야 한다. next-intl은 ' +
        '못 찾은 키를 화면에 그대로 그린다 — 사용자가 코드 낱말을 그대로 보는 결함.',
    );
    return 1;
  }

  console.log('\nOK: 코드가 참조하는 리터럴 키 전부 ko/en에 실존·ko↔en 말단 키 집합 동일.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
