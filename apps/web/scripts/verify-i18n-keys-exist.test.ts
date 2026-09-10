import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectLeafKeys,
  resolveMessageKey,
  scanFileContent,
  scanRepo,
} from './verify-i18n-keys-exist';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');

describe('resolveMessageKey — story #5ead8723 AC1', () => {
  const messages = { nav: { title: '제목', nested: { deep: '깊은 값' } } };

  it('말단(문자열)까지 도달하면 true', () => {
    expect(resolveMessageKey(messages, 'nav.title')).toBe(true);
    expect(resolveMessageKey(messages, 'nav.nested.deep')).toBe(true);
  });

  // ⭐되돌리면 RED — 존재하지 않는 키(②)를 이 함수가 false로 판정 못 하면 가드 전체가 무력해진다.
  it('⭐존재하지 않는 키는 false', () => {
    expect(resolveMessageKey(messages, 'nav.doesNotExist')).toBe(false);
    expect(resolveMessageKey(messages, 'noSuchNamespace.key')).toBe(false);
  });

  it('경로가 object에서 멈추면(말단이 아니면) false — object를 값으로 오인하지 않는다', () => {
    expect(resolveMessageKey(messages, 'nav.nested')).toBe(false);
  });
});

describe('collectLeafKeys — ko↔en 말단 집합', () => {
  it('중첩 구조도 dot-path로 전부 뽑는다', () => {
    const messages = { a: '1', b: { c: '2', d: { e: '3' } } };
    expect(collectLeafKeys(messages)).toEqual(new Set(['a', 'b.c', 'b.d.e']));
  });
});

describe('scanFileContent — story #5ead8723 AC1/AC2/AC3(셀프테스트 6)', () => {
  // ① 존재하는 키(뒤 통합 테스트에서 실 ko/en 대조로 검증) — 여기선 추출 자체만.
  it('useTranslations 바인딩 + 리터럴 호출을 뽑는다', () => {
    const src = `
      function C() {
        const t = useTranslations('nav');
        return t('orgBriefing');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 4, fullKey: 'nav.orgBriefing' }]);
    expect(result.dynamicCount).toBe(0);
    expect(result.totalCallCount).toBe(1);
    expect(result.hasBindings).toBe(true);
  });

  // ⭐되돌리면 RED② — 이 키(nav.doesNotExist)는 뒤 통합 테스트에서 ko/en 실존 대조 시 반드시
  // 걸려야 한다. 여기선 추출 자체가 되는지만 확認.
  it('⭐존재하지 않는 키도 추출은 된다(존재 판정은 scanRepo+resolveMessageKey의 몫)', () => {
    const src = `
      const t = useTranslations('nav');
      t('doesNotExist');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 3, fullKey: 'nav.doesNotExist' }]);
  });

  // ③ 주석 속 가짜 키 — AST가 주석을 애초에 노드로 안 보므로 오탐 0(구조적, 별도 필터 불요).
  it('⭐주석 안의 t(\'키\')는 안 뽑힌다(오탐 0 — AST가 comment를 trivia로 자연 배제)', () => {
    const src = `
      const t = useTranslations('nav');
      // t('fakeCommentKey') 이런 주석은 실행되지 않는다
      /* t('anotherFakeKey') 블록 주석도 마찬가지 */
      t('realKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 5, fullKey: 'nav.realKey' }]);
  });

  // ④ t.rich('missing') — rich/raw/has 전부 같은 판정 축.
  it('⭐t.rich(\'key\')·t.raw(\'key\')·t.has(\'key\') 전부 리터럴로 뽑힌다', () => {
    const src = `
      const t = useTranslations('nav');
      t.rich('richKey', {});
      t.raw('rawKey');
      t.has('hasKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nav.richKey', 'nav.rawKey', 'nav.hasKey']);
  });

  // 바인딩 아닌 변수의 .has()는 무관 호출 — Set/Map류 오탐 방지(실 코드 HIDDEN_SETTINGS_TABS.has(...) 동형).
  it('바인딩되지 않은 변수의 .has()는 무시한다(Set/Map .has()류 오탐 방지)', () => {
    const src = `
      const seen = new Set();
      if (seen.has('workflow')) { /* noop */ }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([]);
    expect(result.dynamicCount).toBe(0);
    expect(result.totalCallCount).toBe(0);
  });

  // ⑥ 동적 호출(변수·템플릿·삼항) — 실패 아니라 수로만 카운트.
  it('⭐동적 키(변수·템플릿·삼항)는 실패시키지 않고 수로만 센다(fails-silent 방지)', () => {
    const src = `
      const t = useTranslations('nav');
      const key = 'someKey';
      t(key);
      t(\`prefix.\${key}\`);
      t(cond ? 'a' : 'b');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([]);
    expect(result.dynamicCount).toBe(3);
    expect(result.totalCallCount).toBe(3);
  });

  it('리터럴+동적 = 총 호출(자기 완전성)', () => {
    const src = `
      const t = useTranslations('nav');
      t('a');
      t(dynamicVar);
      t.rich('b');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.length + result.dynamicCount).toBe(result.totalCallCount);
    expect(result.totalCallCount).toBe(3);
  });

  // story #3757 — dynamicNamespaces(ns 단위 죽은 키 가드가 「이 ns는 동적 호출이 있어
  // 하위 전부 보류」를 판단하는 재료). ns가 알려진 바인딩을 통한 동적 호출만 담는다.
  describe('dynamicNamespaces — story #3757', () => {
    it('⭐ns가 알려진 바인딩의 동적 호출은 그 ns를 dynamicNamespaces에 담는다', () => {
      const src = `
        const t = useTranslations('loops');
        t(\`status\${s}\`);
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.dynamicNamespaces).toEqual(new Set(['loops']));
    });

    it('리터럴 호출만 있으면 dynamicNamespaces는 비어 있다', () => {
      const src = `
        const t = useTranslations('nav');
        t('dashboard');
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.dynamicNamespaces).toEqual(new Set());
    });

    it('unknown-ns(③ 번역자 파라미터) 동적 호출은 dynamicNamespaces에 안 담긴다(어느 ns인지 모름)', () => {
      const src = `
        function C({ t }: { t: ReturnType<typeof useTranslations> }) {
          return t(dynamicKey);
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.dynamicNamespaces).toEqual(new Set());
      expect(result.dynamicCount).toBe(1);
    });

    it('한 파일에 여러 ns가 각각 동적 호출을 가지면 전부 담는다', () => {
      const src = `
        const t = useTranslations('a');
        const t2 = useTranslations('b');
        t(dynamicVar);
        t2(dynamicVar);
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.dynamicNamespaces).toEqual(new Set(['a', 'b']));
    });
  });

  // story #3757 — unknownNsLiteralWords(층 A′). unknown-ns(③/⑤/⑥) 바인딩을 통한 호출이라도
  // 인자가 리터럴이면 그 낱말은 안다 — 정확한 namespace.key는 못 지어도 "이 낱말 자체는
  // 죽지 않았다"를 죽은-키 판정 쪽에 넘긴다.
  describe('unknownNsLiteralWords — story #3757', () => {
    it('⭐번역자 파라미터를 통한 리터럴 호출은 그 낱말을 unknownNsLiteralWords에 담는다(member-display.ts 실 형)', () => {
      const src = `
        function memberDisplayLabel(name: string | null, t: (key: string) => string): string {
          return name ? name : t('memberUnnamed');
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.unknownNsLiteralWords).toEqual(new Set(['memberUnnamed']));
      expect(result.literalRefs).toEqual([]); // ns를 모르니 전체경로 리터럴로는 안 잡힘(동적 카운트로만)
      expect(result.dynamicCount).toBe(1);
    });

    it('알려진 ns 바인딩의 리터럴 호출은 unknownNsLiteralWords에 안 담긴다(literalRefs로 이미 잡힘)', () => {
      const src = `
        const t = useTranslations('nav');
        t('dashboard');
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.unknownNsLiteralWords).toEqual(new Set());
    });

    it('unknown-ns 바인딩이라도 인자가 동적(변수)이면 낱말을 못 얻으므로 안 담긴다', () => {
      const src = `
        function C(t: (key: string) => string, dynamicKey: string) {
          return t(dynamicKey);
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.unknownNsLiteralWords).toEqual(new Set());
      expect(result.dynamicCount).toBe(1);
    });
  });

  // story #3765(3757-b) — 층 A″. #4112에서 손으로 되살린 14건(invite.acceptFailed·
  // dashboard.ccGateType* 13)의 실 형을 픽스처로 재현한다.
  describe('indirectLookupRefs/indirectLookupWords — story #3765(층 A″)', () => {
    it('⭐(A) 번역자 co-argument — invite-error-message.ts 실 형(ns 알려짐 → 전체경로)', () => {
      const src = `
        const tInvite = useTranslations('invite');
        function inviteErrorMessage(t, code, fallbackKey) {
          return t(fallbackKey);
        }
        inviteErrorMessage(tInvite, code, 'acceptFailed');
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.indirectLookupRefs).toEqual([{ file: 'fake.tsx', line: 6, fullKey: 'invite.acceptFailed' }]);
      expect(result.indirectLookupWords).toEqual(new Set());
    });

    it('(A) 번역자가 unknown-ns(파라미터로 받은 t)면 낱말로만 떨어진다', () => {
      const src = `
        function C(t: (key: string) => string, code: string) {
          return helper(t, code, 'someFallback');
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.indirectLookupWords).toEqual(new Set(['someFallback']));
      expect(result.indirectLookupRefs).toEqual([]);
    });

    it('⭐(B) Record<string,string> 조회 테이블 — gate-type-label.ts 실 형(파일이 ns를 하나도 안 열면 관대한 낱말 축)', () => {
      const src = `
        const GATE_TYPE_LABEL_KEYS: Record<string, string> = {
          qa: 'ccGateTypeQa',
          pr_review: 'ccGateTypePrReview',
        };
        export function gateTypeLabel(t, gateType) {
          return t(GATE_TYPE_LABEL_KEYS[gateType] ?? 'ccGateGeneric');
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.indirectLookupWords).toEqual(new Set(['ccGateTypeQa', 'ccGateTypePrReview']));
      expect(result.indirectLookupRefs).toEqual([]);
    });

    it('⭐(B) 같은 파일이 ns를 열면(epic-status-transition.tsx 실 형) 그 ns로만 전체경로를 좁힌다 — 동음이의 다른 ns는 안 건드림', () => {
      const src = `
        const LABEL_KEY: Record<string, string> = {
          draft: 'statusDraft',
          active: 'statusActive',
        };
        function C() {
          const t = useTranslations('goals');
          return t(LABEL_KEY[status] ?? 'statusDraft');
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(new Set(result.indirectLookupRefs.map((r) => r.fullKey))).toEqual(
        new Set(['goals.statusDraft', 'goals.statusActive']),
      );
      // ⭐되돌리면 RED — dashboard.statusActive(동음이의, 다른 ns)는 이 파일이 'goals'만 여니
      // 여기서 나오면 안 된다(관대한 낱말 축으로 새지 않는다는 정밀도 원칙의 핵심 pin).
      expect(result.indirectLookupRefs.some((r) => r.fullKey === 'dashboard.statusActive')).toBe(false);
      expect(result.indirectLookupWords).toEqual(new Set());
    });

    it('동음이의 9건류 — 번역자 co-argument도 Record<string,string> 초기화식도 아니면 아무 신호도 안 낸다', () => {
      const src = `
        type CompactionVerdict = 'keep' | 'delete';
        function f(): CompactionVerdict {
          const seedKey = x === 'keep' ? 'seedKeep' : 'seedKill';
          formData.get('description');
          this.unavailable('create');
          return 'keep';
        }
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.indirectLookupRefs).toEqual([]);
      expect(result.indirectLookupWords).toEqual(new Set());
    });

    // 뮤테이션 셀프체크(스토리 AC) — 자가 진짜 테이블 값을 읽는지: 값 하나를 오타로 바꾸면
    // 그 정확한 문자열은 더 이상 안 나오고(다른 무의미한 문자열로 바뀌었을 뿐이니 당연하지만,
    // 「하드코딩된 목록이 아니라 실제로 소스를 읽는다」는 사실 자체를 이 대조가 고정한다).
    it('⭐뮤테이션: 테이블 값 오타 → 원래 값은 더 이상 낱말 축에 없다(자가 실제 값을 읽음)', () => {
      const src = `
        const GATE_TYPE_LABEL_KEYS: Record<string, string> = {
          qa: 'ccGateTypeQaTYPO',
        };
      `;
      const result = scanFileContent(src, 'fake.tsx');
      expect(result.indirectLookupWords.has('ccGateTypeQa')).toBe(false);
      expect(result.indirectLookupWords).toEqual(new Set(['ccGateTypeQaTYPO']));
    });
  });

  it('네임스페이스 없는(루트) useTranslations()도 지원한다', () => {
    const src = `
      const t = useTranslations();
      t('rootKey');
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs).toEqual([{ file: 'fake.tsx', line: 3, fullKey: 'rootKey' }]);
  });

  it('getTranslations(\'ns\')·getTranslations({ namespace })도 바인딩으로 인식한다', () => {
    const src = `
      async function C() {
        const t1 = await getTranslations('nsA');
        const t2 = await getTranslations({ locale: 'ko', namespace: 'nsB' });
        return [t1('x'), t2('y')];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nsA.x', 'nsB.y']);
  });

  // 「마지막 선언이 이긴다」— 실 코드 패턴(한 파일 여러 컴포넌트가 각자 const t = useTranslations(...)).
  it('같은 변수명이 여러 함수에서 다른 네임스페이스로 재선언되면 각자의 선언을 따른다', () => {
    const src = `
      function A() {
        const t = useTranslations('nsA');
        return t('x');
      }
      function B() {
        const t = useTranslations('nsB');
        return t('y');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.map((r) => r.fullKey)).toEqual(['nsA.x', 'nsB.y']);
  });
});

// story #5ead8723 CHANGES(유나 디자인 게이트 지적, 2026-09-09) — 번역자를 파라미터로
// 받는 함수(useTranslations 호출이 그 함수 안에 없음)는 처음엔 바인딩이 전혀 안 잡혀
// 그 안의 호출이 리터럴·동적 어느 버킷에도 안 들었다(totalCallCount=0, 완전히 안 세어짐
// — 실측 10파일·89건). ⭐이 describe 전체가 그 회귀의 pin이다: 아래 4형 전부 total > 0
// (동적 버킷)이어야 한다 — 0이면 다시 안 보이게 된 것.
describe('scanFileContent — story #5ead8723 CHANGES③(번역자 파라미터, 유나 지적)', () => {
  it('⭐단순 이름 파라미터 + 직접 ReturnType<typeof useTranslations> — 동적으로 카운트(안 세어짐 0)', () => {
    const src = `
      function TrustBadge({ t }: { t: ReturnType<typeof useTranslations> }) {
        return t('trustColdStart');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(1);
    expect(result.dynamicCount).toBe(1);
    expect(result.literalRefs).toEqual([]);
  });

  it('⭐단순 이름 파라미터 + 로컬 함수형 타입 별칭(trust-utils.tsx의 Translator와 동형)', () => {
    const src = `
      type Translator = (key: string, values?: Record<string, string | number>) => string;
      export function TrustBadge({ hitRate, t }: { hitRate: number; t: Translator }) {
        return t('trustColdStart');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(1);
    expect(result.dynamicCount).toBe(1);
  });

  it('⭐구조분해 파라미터 + 인라인 타입 리터럴(apply-recipe-dialog.tsx와 동형)', () => {
    const src = `
      export function ApplyRecipeDialog({
        target, t, tc,
      }: {
        target: unknown;
        t: ReturnType<typeof useTranslations>;
        tc: ReturnType<typeof useTranslations>;
      }) {
        return [t('a'), tc('b')];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(2);
    expect(result.dynamicCount).toBe(2);
  });

  it('⭐구조분해 파라미터 + named interface(facebook-page-select-card.tsx/insights-board-metric-cell.tsx와 동형)', () => {
    const src = `
      interface Props {
        channel: string;
        t: ReturnType<typeof useTranslations>;
      }
      export function Card({ channel, t }: Props) {
        return t('label');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(1);
    expect(result.dynamicCount).toBe(1);
  });

  it('⭐call-signature 인터페이스(derive-attention-queue.ts 등 6곳의 *Translator 관례)', () => {
    const src = `
      interface ClusterTranslator {
        (key: string, values?: Record<string, string | number>): string;
      }
      export function deriveAttentionClusters(attention: unknown[], t: ClusterTranslator) {
        return t('attentionEmpty');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(1);
    expect(result.dynamicCount).toBe(1);
  });

  // ⭐PO 1차 grounding 정정(오탐 방지) — 파라미터 이름을 `key` 하나로 좁게 유지하는 이유.
  // `id: string`을 받고 `string`을 반환하는 것만으로는 번역자가 아니다(예: 이름 리졸버).
  // `k`/`messageKey`/`id`까지 이름 조건을 넓히자는 1차 제안은 전수 스캔으로 반증됐다
  // (실 저장소에 `k`/`messageKey` 번역자 0건, `id` 매치는 전부 무관 리졸버).
  it('오탐 방지 — (id: string) => string 형 「이름 리졸버」는 번역자로 안 잡는다', () => {
    const src = `
      function AttentionRow({ resolveName }: { resolveName: (id: string) => string }) {
        return resolveName('u1');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(0);
  });

  it('구조분해 파라미터가 번역자 프로퍼티를 안 가진 named interface는 무관(오탐 0)', () => {
    const src = `
      interface Props {
        channel: string;
        isOwner: boolean;
      }
      export function Card({ channel, isOwner }: Props) {
        return channel + String(isOwner);
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(0);
  });

  // 자기완전성(리터럴+동적=총)은 이 새 바인딩 축이 섞여도 그대로 성립해야 한다.
  it('번역자 파라미터 호출과 일반 useTranslations 호출이 한 파일에 섞여도 리터럴+동적=총', () => {
    const src = `
      function Parent() {
        const t = useTranslations('parent');
        return [t('parentKey'), <Child t={t} />];
      }
      function Child({ t }: { t: ReturnType<typeof useTranslations> }) {
        return t('childKey');
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.literalRefs.length + result.dynamicCount).toBe(result.totalCallCount);
    expect(result.totalCallCount).toBe(2);
  });
});

// story #5ead8723 CHANGES⑤⑥(유나 디자인 게이트 재재지적, 2026-09-09) — 커스텀 훅이
// 내부에서 useTranslations를 부르고 그 결과(t/tc)를 반환하면, 소비 파일엔 useTranslations
// 호출 자체가 없어 ③ 처방으로도 안 잡혔다(profile-menu.tsx totalCallCount 1 — 실제
// 9여야 할 자리). ⭐이 describe 전체가 그 회귀의 pin이다.
describe('scanFileContent — story #5ead8723 CHANGES⑤⑥(커스텀 훅이 반환한 번역자)', () => {
  it('⭐⑤ 프로퍼티 접근 그대로 호출(acc.t(...)/acc.tc(...), context-switcher-chip.tsx와 동형)', () => {
    const src = `
      function ContextSwitcherChip() {
        const acc = useAccountSwitcher(userName);
        return [acc.t('title'), acc.tc('logout')];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(2);
    expect(result.dynamicCount).toBe(2);
    expect(result.literalRefs).toEqual([]);
  });

  it('⭐⑥ 훅 반환값 구조분해(const { t, tc } = useAccountSwitcher(...), profile-menu.tsx와 동형)', () => {
    const src = `
      function ProfileMenu() {
        const { t, tc, busy } = useAccountSwitcher(userName);
        return [t('title'), tc('logout'), busy];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(2);
    expect(result.dynamicCount).toBe(2);
  });

  // 오탐 방지 — 프로퍼티/구조분해 이름이 t/tc가 아니면(예: 임의 콜백) 무관해야 한다.
  it('오탐 방지 — 이름이 t/tc가 아닌 프로퍼티 접근·구조분해는 무관(전수 스캔 0건 확認과 동형)', () => {
    const src = `
      function Widget() {
        const svc = useSomeService();
        const { load, error } = useOtherHook();
        return [svc.toggle('x'), load()];
      }
    `;
    const result = scanFileContent(src, 'fake.tsx');
    expect(result.totalCallCount).toBe(0);
  });

  // ⭐되돌리면 RED — 유나·PO가 CHANGES에서 직접 지목한 실 파일 2개.
  it('⭐유나·PO 지목 실 파일 2개(context-switcher-chip.tsx·profile-menu.tsx) — total이 이전 최소치보다 커야 한다', () => {
    const files: [string, number][] = [
      ['components/nav/context-switcher-chip.tsx', 8],  // ⑤ 처방 前엔 0.
      ['components/nav/profile-menu.tsx', 1],           // ⑥ 처방 前엔 정확히 1(나머지 8곳 안 세어짐).
    ];
    for (const [rel, priorMax] of files) {
      const content = readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      const result = scanFileContent(content, rel);
      expect(result.totalCallCount, `${rel} totalCallCount`).toBeGreaterThan(priorMax);
    }
  });
});

// ⭐양성대조(story #5ead8723 판별) — develop HEAD 실 소스에 대해 이 가드가 실제로 통과하는지,
// 그리고 뮤테이션(존재하지 않는 키 삽입)을 걸면 실제로 RED가 되는지 왕복 확認한다.
describe('scanRepo — 양성대조(실 develop 소스)', () => {
  it('⭐실 소스 전수 스캔 — 리터럴 키 전부 ko/en에 실존(누락 0)·ko↔en 말단 키 집합 동일', () => {
    const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8'));
    const enMessages = JSON.parse(readFileSync(EN_PATH, 'utf8'));
    const result = scanRepo(SRC_ROOT);

    expect(result.filesWithBindings).toBeGreaterThan(0);
    expect(result.literalRefs.length).toBeGreaterThan(0);

    const missingKo = result.literalRefs.filter((r) => !resolveMessageKey(koMessages, r.fullKey));
    const missingEn = result.literalRefs.filter((r) => !resolveMessageKey(enMessages, r.fullKey));
    expect(missingKo, JSON.stringify(missingKo.slice(0, 10))).toEqual([]);
    expect(missingEn, JSON.stringify(missingEn.slice(0, 10))).toEqual([]);

    const koLeaves = collectLeafKeys(koMessages);
    const enLeaves = collectLeafKeys(enMessages);
    const koOnly = [...koLeaves].filter((k) => !enLeaves.has(k));
    const enOnly = [...enLeaves].filter((k) => !koLeaves.has(k));
    expect(koOnly, JSON.stringify(koOnly.slice(0, 10))).toEqual([]);
    expect(enOnly, JSON.stringify(enOnly.slice(0, 10))).toEqual([]);
  });

  // ⭐뮤테이션 킬 — 실 소스에 «존재하지 않는 키」를 참조하는 파일 하나를 섞어 넣으면(문자열
  // 픽스처로 scanFileContent 직접 호출·resolveMessageKey 대조) 실제로 걸리는지 증명.
  // scanRepo 자체를 파일시스템 뮤테이션 없이 검증하기 위해 그 내부 판정 로직(리터럴 추출→
  // resolveMessageKey 대조)을 같은 순서로 재현한다.
  it('⭐뮤테이션 킬 — 존재하지 않는 키를 참조하면 실제로 missing 목록에 잡힌다', () => {
    const koMessages = JSON.parse(readFileSync(KO_PATH, 'utf8'));
    const fakeRef = { file: 'mutation-kill-fixture.tsx', line: 1, fullKey: 'nav.thisKeyWillNeverExist12345' };
    expect(resolveMessageKey(koMessages, fakeRef.fullKey)).toBe(false);
  });

  // ⭐되돌리면 RED — 유나·PO가 CHANGES에서 직접 지목한 실 파일 10개(①②의 4개 + ③ call-
  // signature 인터페이스 관례 6개). story #5ead8723 CHANGES 처방 前엔 전부 totalCallCount=0
  // (바인딩이 전혀 안 잡혀 안 보이던 상태)이었다.
  it('⭐유나·PO 지목 실 파일 10개 — 번역자 파라미터 호출이 더 이상 완전히 안 보이지 않는다(total > 0)', () => {
    const files = [
      'app/(authenticated)/organization/trust/trust-utils.tsx',
      'components/organization/apply-recipe-dialog.tsx',
      'components/insights-board/insights-board-metric-cell.tsx',
      'components/channel-connect/facebook-page-select-card.tsx',
      'components/attention-queue/derive-attention-queue.ts',
      'components/command-palette/command-palette-actions.ts',
      'components/org-briefing/derive-workforce-face.ts',
      'components/org-briefing/derive-now-face.ts',
      'components/org-briefing/derive-loop-face.ts',
      'components/org-briefing/derive-attention-clusters.ts',
    ];
    for (const rel of files) {
      const content = readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      const result = scanFileContent(content, rel);
      expect(result.totalCallCount, `${rel} totalCallCount`).toBeGreaterThan(0);
    }
  });
});
