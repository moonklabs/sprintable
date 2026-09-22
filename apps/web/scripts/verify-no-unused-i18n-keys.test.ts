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

  it('E: TEMPLATE_KEY_TABLE 전개값이면 참조됨(예: gateConfig.work_done)', () => {
    expect(isKeyReferenced('gateConfig.work_done', inputs())).toBe(true);
  });

  // ⭐음성대조 — 다섯 신호가 전부 없으면 RED 대상(죽은-키 후보).
  it('⭐음성대조 — 다섯 신호가 전부 없으면 참조 안 됨', () => {
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

    const enPath = path.join(dir, 'en.json');
    const messages = {
      nsA: { label: 'Label' }, // A로 살아남아야 함.
      nsD: { unnamedLabel: 'No name' }, // A′로 살아남아야 함.
      settings: { event_story: 'Story event' }, // B(DYNAMIC_KEY_PREFIXES)로 살아남아야 함.
      gateConfig: { work_done: 'Done' }, // E(TEMPLATE_KEY_TABLE)로 살아남아야 함(소스 참조 0).
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
