import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isKeyReferenced, loadBaseline, runScan, type DeadKeyScanInputs } from './verify-no-unused-i18n-keys';

describe('isKeyReferenced — story #3732', () => {
  function inputs(overrides: Partial<DeadKeyScanInputs> = {}): DeadKeyScanInputs {
    return {
      enLeaves: new Set(),
      literalRefFullKeys: new Set(),
      indirectLookupRefFullKeys: new Set(),
      unknownNsLiteralWords: new Set(),
      indirectLookupWords: new Set(),
      tableBareKeys: new Set(),
      ...overrides,
    };
  }

  it('A: 전체경로 리터럴 참조가 있으면 참조됨', () => {
    expect(isKeyReferenced('nsA.label', inputs({ literalRefFullKeys: new Set(['nsA.label']) }))).toBe(true);
  });

  it('A″: indirectLookupRefs(co-argument/테이블값, ns 앎)가 있으면 참조됨', () => {
    expect(isKeyReferenced('invite.acceptFailed', inputs({ indirectLookupRefFullKeys: new Set(['invite.acceptFailed']) }))).toBe(true);
  });

  it("A′: unknown-ns 낱말이 말단 세그먼트와 일치하면 참조됨", () => {
    expect(isKeyReferenced('common.memberUnnamed', inputs({ unknownNsLiteralWords: new Set(['memberUnnamed']) }))).toBe(true);
  });

  it('A″-word: indirectLookupWords(ns 모르는 co-argument/테이블값)가 말단 세그먼트와 일치하면 참조됨', () => {
    expect(isKeyReferenced('dashboard.ccGateTypeQa', inputs({ indirectLookupWords: new Set(['ccGateTypeQa']) }))).toBe(true);
  });

  it('B: DYNAMIC_KEY_PREFIXES 대상이면 참조됨(예: settings.event_story)', () => {
    expect(isKeyReferenced('settings.event_story', inputs())).toBe(true);
  });

  // story #3732 첫 실전 오탐(2026-09-22, develop CI RED·PO 그라운딩) — api-error.ts:176
  // `labelKey: 'errorExternalPublishPaused'`류 데이터 카탈로그 선언(소비는 다른 파일의
  // t(entry.labelKey) 간접 호출이라 A/A″/A′ 어디에도 안 걸림)이 죽은-키 후보로 오판됐다.
  // #3757 collectTableBareKeys 재사용으로 메운 신호.
  it('C: 데이터 카탈로그(labelKey류) 낱말이 말단 세그먼트와 일치하면 참조됨(예: content.errorExternalPublishPaused)', () => {
    expect(isKeyReferenced(
      'content.errorExternalPublishPaused',
      inputs({ tableBareKeys: new Set(['errorExternalPublishPaused']) }),
    )).toBe(true);
  });

  it('E: TEMPLATE_KEY_TABLE 전개값이면 참조됨(예: gateConfig.work_done)', () => {
    expect(isKeyReferenced('gateConfig.work_done', inputs())).toBe(true);
  });

  // ⭐음성대조 — 여섯 신호가 전부 없으면 RED 대상(죽은-키 후보).
  it('⭐음성대조 — 여섯 신호가 전부 없으면 참조 안 됨', () => {
    expect(isKeyReferenced('nsDead.orphanKey', inputs())).toBe(false);
  });

  it('다른 키의 신호는 이 키를 못 살린다(키 경계 존중)', () => {
    expect(isKeyReferenced('nsA.other', inputs({ literalRefFullKeys: new Set(['nsA.label']) }))).toBe(false);
  });
});

// story #3732(카디르 qa 대응 재발 방지, #3757 동형 규율) — runScan()이 실제로 신호들을
// 파이프라인에 배선하는지 임시 픽스처로 끝까지 돌려 확인. 순수 함수(isKeyReferenced)
// 유닛 테스트만으론 이 배선 자체는 안 잰다.
describe('runScan — 파이프라인 통합(story #3732)', () => {
  function makeFixture(): { dir: string; srcRoot: string; enPath: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'i18n-dead-key-fixture-'));
    const srcRoot = path.join(dir, 'src', 'components');
    mkdirSync(srcRoot, { recursive: true });

    // A: 직접 리터럴 호출.
    writeFileSync(
      path.join(srcRoot, 'a-widget.tsx'),
      `
        import { useTranslations } from 'next-intl';
        export function AWidget() {
          const t = useTranslations('nsA');
          return <div>{t('label')}</div>;
        }
      `,
    );
    // A′: 번역자 파라미터를 통한 리터럴 — ns를 몰라 낱말 축으로만.
    writeFileSync(
      path.join(srcRoot, 'helper.ts'),
      `
        export function label(t: (key: string) => string): string {
          return t('unnamedLabel');
        }
      `,
    );
    // B: 동적 접두사(DYNAMIC_KEY_PREFIXES의 실제 등재 접두사 하나 재사용 — settings.event_).
    writeFileSync(
      path.join(srcRoot, 'events.ts'),
      `
        import { useTranslations } from 'next-intl';
        export function EventLabel(eventType: string) {
          const t = useTranslations('settings');
          return t(\`event_\${eventType}\`);
        }
      `,
    );
    // PO PASS 비차단①(2026-09-22) — PR 본문이 "멤버접근·.rich() 표본"을 주장했는데 실
    // 픽스처엔 없었다(unit 레벨 isKeyReferenced 표본과 통합 파이프라인 표본을 혼동한 결함).
    // 실 저장소 표본(context-switcher-chip.tsx:258 acc.t()·recruiter-client.tsx
    // t.rich(\`kitOrientingWakeBody_\${method}\`) — 후자는 TEMPLATE_KEY_TABLE의 실 등재
    // 항목)을 그대로 미러해 진짜 통합 표본으로 추가한다.
    //
    // ⑤ 멤버접근(`acc.t()`) — use-account-switcher.ts가 useTranslations를 내부에서 불러
    // 반환 객체에 담고, 소비 파일은 그 반환 객체의 프로퍼티로 바로 호출(구조분해 없음).
    writeFileSync(
      path.join(srcRoot, 'use-fake-switcher.ts'),
      `
        import { useTranslations } from 'next-intl';
        export function useFakeSwitcher() {
          const t = useTranslations('accountSwitcher');
          return { t };
        }
      `,
    );
    writeFileSync(
      path.join(srcRoot, 'member-access-widget.tsx'),
      `
        import { useFakeSwitcher } from './use-fake-switcher';
        export function MemberAccessWidget() {
          const acc = useFakeSwitcher();
          return <span>{acc.t('reloginRequired')}</span>;
        }
      `,
    );
    // .rich() — 리터럴 키(TRANSLATION_METHODS: rich/raw/has 지원) 표본.
    writeFileSync(
      path.join(srcRoot, 'rich-widget.tsx'),
      `
        import { useTranslations } from 'next-intl';
        export function RichWidget() {
          const t = useTranslations('nsRich');
          return t.rich('richKey', { bold: (chunks: unknown) => chunks });
        }
      `,
    );

    // C: 데이터 카탈로그(labelKey류) — 실 저장소 api-error.ts:176-421 구조 그대로 미러
    // (Record<string, {labelKey}> 선언 → 다른 함수가 known?.labelKey를 반환 → 소비 파일이
    // t(info.humanMessageKey)로 바닥 변수 호출, #3420/AC8 blind spot). 2026-09-22 develop
    // CI 첫 실전 오탐(content.errorExternalPublishPaused)의 재발 방지 표본.
    writeFileSync(
      path.join(srcRoot, 'known-errors.ts'),
      `
        interface KnownError { labelKey: string; kind: string }
        const KNOWN_ERRORS: Record<string, KnownError> = {
          EXTERNAL_PUBLISH_PAUSED: { labelKey: 'errorExternalPublishPaused', kind: 'external_publish_paused' },
        };
        export function classifyError(code: string) {
          const known = KNOWN_ERRORS[code];
          return { humanMessageKey: known?.labelKey || undefined };
        }
      `,
    );
    writeFileSync(
      path.join(srcRoot, 'error-banner.tsx'),
      `
        import { useTranslations } from 'next-intl';
        import { classifyError } from './known-errors';
        export function ErrorBanner({ code }: { code: string }) {
          const t = useTranslations('content');
          const info = classifyError(code);
          return info.humanMessageKey ? <span>{t(info.humanMessageKey)}</span> : null;
        }
      `,
    );

    const enPath = path.join(dir, 'en.json');
    const messages = {
      nsA: { label: 'Label' }, // A로 살아남아야 함.
      nsD: { unnamedLabel: 'No name' }, // A′로 살아남아야 함.
      settings: { event_story: 'Story event' }, // B(DYNAMIC_KEY_PREFIXES)로 살아남아야 함.
      gateConfig: { work_done: 'Done' }, // E(TEMPLATE_KEY_TABLE)로 살아남아야 함(소스 참조 0).
      accountSwitcher: { reloginRequired: 'Needs relogin' }, // 멤버접근(A′-word)으로 살아남아야 함.
      nsRich: { richKey: 'Rich text' }, // .rich() 리터럴(A)로 살아남아야 함.
      content: { errorExternalPublishPaused: 'Publishing paused' }, // C(테이블 선언)로 살아남아야 함.
      nsDead: { orphanKey: 'Nobody uses this' }, // 다섯 신호 전부 없음 — RED 대상.
    };
    writeFileSync(enPath, JSON.stringify(messages));

    return { dir, srcRoot, enPath };
  }

  it('⭐임시 픽스처를 runScan()으로 끝까지 돌리면 A/A′/B/E 넷 다 각자 살리고 신호 0인 키만 dead로 잡는다', () => {
    const f = makeFixture();
    try {
      const { deadCandidates } = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(deadCandidates).toEqual(['nsDead.orphanKey']);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // ⭐양성대조 ① — 가짜 키(참조 신호 0)를 messages에 심으면 dead-key 후보로 실제로 뜬다.
  it('⭐양성대조 — 참조 신호가 없는 가짜 키를 심으면 죽은-키 후보로 뜬다', () => {
    const f = makeFixture();
    try {
      const before = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(before.deadCandidates).toContain('nsDead.orphanKey');

      // 그 키를 지우면 더 이상 후보가 아니어야 한다(en 리프 자체에서 빠짐).
      const messagesWithoutDead = {
        nsA: { label: 'Label' }, nsD: { unnamedLabel: 'No name' },
        settings: { event_story: 'Story event' }, gateConfig: { work_done: 'Done' },
      };
      writeFileSync(f.enPath, JSON.stringify(messagesWithoutDead));
      const after = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(after.deadCandidates).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  // ⭐양성대조 ② — 살아 있는 키의 유일한 참조를 지우면(=참조 해석이 안 되는 상태로 전환)
  // 그 키가 dead-key 후보로 넘어간다. "해석 불가 1건 주입→RED"의 실질(참조가 사라진
  // 자리는 죽은-키 후보 쪽으로 fail-closed 넘어가야 한다)을 A층 신호로 직접 검증.
  it('⭐양성대조 — 살아 있는 키의 유일한 참조를 지우면 그 키가 죽은-키 후보로 넘어간다', () => {
    const f = makeFixture();
    try {
      const before = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(before.deadCandidates).not.toContain('nsA.label');

      rmSync(path.join(f.srcRoot, 'a-widget.tsx'));
      const after = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(after.deadCandidates).toContain('nsA.label');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

// [SID:4286] 결재 카드 · 토스 시트 · 문서 게이트가 `t(x.fallback ? 'keyFallback' : 'key', …)`로
// 두 키를 고른다 — 두 가지가 다 문자열이면 두 키 다 소비다. 한 가지가 변수면 리터럴 가지도
// «못 셈»(값을 지어내지 않는다), 진짜 안 쓰는 키는 여전히 죽은-키 후보.
describe('runScan — 삼항 첫 인자([SID:4286])', () => {
  function makeFixture(): { dir: string; srcRoot: string; enPath: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'i18n-dead-key-ternary-'));
    const srcRoot = path.join(dir, 'src', 'components');
    mkdirSync(srcRoot, { recursive: true });
    writeFileSync(
      path.join(srcRoot, 'approval-card.tsx'),
      `
        import { useTranslations } from 'next-intl';
        export function ApprovalCard({ fallback, name, k }: { fallback: boolean; name: string; k: string }) {
          const t = useTranslations('nsTern');
          return (
            <div>
              {t(fallback ? 'waitingOnFallback' : 'waitingOn', { name })}
              {t(fallback ? 'halfLiteral' : k)}
            </div>
          );
        }
      `,
    );
    const enPath = path.join(dir, 'en.json');
    writeFileSync(enPath, JSON.stringify({
      nsTern: {
        waitingOn: 'Waiting on {name}',
        waitingOnFallback: 'Waiting on {name} (fallback)',
        halfLiteral: 'Only one branch is a literal',
        reallyUnused: 'Nobody uses this',
      },
    }));
    return { dir, srcRoot, enPath };
  }

  it('두 가지가 다 문자열인 삼항 → 두 키 다 소비 · 한 가지가 변수면 리터럴 가지도 못 셈 · 안 쓰는 키는 RED', () => {
    const f = makeFixture();
    try {
      const { deadCandidates } = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(deadCandidates).toEqual(['nsTern.halfLiteral', 'nsTern.reallyUnused']);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('양성 대조 — 삼항 호출이 있는 파일을 지우면 두 키가 죽은-키 후보로 넘어간다(삼항만이 두 키를 살렸다)', () => {
    const f = makeFixture();
    try {
      rmSync(path.join(f.srcRoot, 'approval-card.tsx'));
      writeFileSync(path.join(f.srcRoot, 'empty.ts'), 'export const x = 1;\n');
      const { deadCandidates } = runScan({ srcRoot: f.srcRoot, enPath: f.enPath, minExpectedFiles: 1 });
      expect(deadCandidates).toEqual([
        'nsTern.halfLiteral', 'nsTern.reallyUnused', 'nsTern.waitingOn', 'nsTern.waitingOnFallback',
      ]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('loadBaseline — story #3732', () => {
  it('key/reason 배열을 읽는다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'i18n-dead-key-baseline-'));
    try {
      const file = path.join(dir, 'baseline.json');
      writeFileSync(file, JSON.stringify([{ key: 'nsX.dead', reason: 'grandfather' }]));
      expect(loadBaseline(file)).toEqual([{ key: 'nsX.dead', reason: 'grandfather' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
