import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectTableBareKeys, isNamespaceReferenced, loadOverlayAllowlist, runScan,
  type NamespaceReferenceInputs,
} from './verify-i18n-namespace-referenced';

function baseInputs(overrides: Partial<NamespaceReferenceInputs> = {}): NamespaceReferenceInputs {
  return {
    topLevelNamespaces: new Set(['nav']),
    literalRefFullKeys: new Set(),
    dynamicNamespaces: new Set(),
    unknownNsLiteralWords: new Set(),
    tableBareKeys: new Set(),
    overlayNamespaces: new Set(),
    leafKeysByNamespace: new Map([['nav', new Set(['dashboard'])]]),
    ...overrides,
  };
}

describe('isNamespaceReferenced — story #3757', () => {
  it('A: 전체경로 리터럴 참조가 있으면 참조됨', () => {
    const inputs = baseInputs({ literalRefFullKeys: new Set(['nav.dashboard']) });
    expect(isNamespaceReferenced('nav', inputs)).toBe(true);
  });

  it('B: 동적 호출이 있는 ns는 참조됨(모름≠안 됨)', () => {
    const inputs = baseInputs({ dynamicNamespaces: new Set(['nav']) });
    expect(isNamespaceReferenced('nav', inputs)).toBe(true);
  });

  it("A′: unknown-ns 낱말이 이 ns의 leaf bare와 일치하면 참조됨", () => {
    const inputs = baseInputs({ unknownNsLiteralWords: new Set(['dashboard']) });
    expect(isNamespaceReferenced('nav', inputs)).toBe(true);
  });

  it('C: 데이터 카탈로그 낱말이 이 ns의 leaf bare와 일치하면 참조됨', () => {
    const inputs = baseInputs({ tableBareKeys: new Set(['dashboard']) });
    expect(isNamespaceReferenced('nav', inputs)).toBe(true);
  });

  it('D: SaaS 오버레이가 이 ns를 열면 참조됨', () => {
    const inputs = baseInputs({ overlayNamespaces: new Set(['nav']) });
    expect(isNamespaceReferenced('nav', inputs)).toBe(true);
  });

  it('⭐음성대조 — 네 신호가 전부 없으면 참조 안 됨(RED 대상)', () => {
    const inputs = baseInputs();
    expect(isNamespaceReferenced('nav', inputs)).toBe(false);
  });

  it('다른 ns의 신호는 이 ns를 못 살린다(namespace 경계 존중)', () => {
    const inputs = baseInputs({
      literalRefFullKeys: new Set(['other.dashboard']),
      unknownNsLiteralWords: new Set(),
    });
    expect(isNamespaceReferenced('nav', inputs)).toBe(false);
  });
});

describe('collectTableBareKeys — story #3757', () => {
  it('descriptionKey/labelKey 등 등재된 필드의 리터럴 값을 모은다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'table-bare-keys-'));
    try {
      writeFileSync(
        path.join(dir, 'nav-config.ts'),
        `export const items = [{ labelKey: 'board', descriptionKey: 'descBoard' }];`,
      );
      const keys = collectTableBareKeys(dir);
      expect(keys).toEqual(new Set(['board', 'descBoard']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('등재 안 된 *Key 필드(예: apiKey)는 안 잡는다(오탐 방지)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'table-bare-keys-neg-'));
    try {
      writeFileSync(path.join(dir, 'auth.ts'), `const cfg = { apiKey: 'sk_live_xxx' };`);
      const keys = collectTableBareKeys(dir);
      expect(keys).toEqual(new Set());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadOverlayAllowlist — story #3757', () => {
  it('sha·date·namespaces를 읽는다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'overlay-allowlist-'));
    try {
      const file = path.join(dir, 'overlay.json');
      writeFileSync(file, JSON.stringify({
        overlay_commit_sha: 'abc123', overlay_commit_date: '2026-01-01', namespaces: ['billing'],
      }));
      const loaded = loadOverlayAllowlist(file);
      expect(loaded.namespaces).toEqual(['billing']);
      expect(loaded.overlay_commit_sha).toBe('abc123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// story #3757(카디르 qa:changes on #4107 동형 재발 방지) — runScan()이 실제로 4개 신호를
// 전부 파이프라인에 연결하는지 임시 픽스처로 끝까지 돌려 확인. 순수 함수(isNamespaceReferenced)
// 유닛 테스트만으론 이 배선 자체는 안 잰다.
describe('runScan — 파이프라인 통합(story #3757)', () => {
  function makeFixture(): { dir: string; srcRoot: string; koPath: string; enPath: string; overlayAllowlistPath: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'i18n-ns-fixture-'));
    const srcRoot = path.join(dir, 'src', 'components');
    mkdirSync(srcRoot, { recursive: true });

    // A: 리터럴 참조 ns.
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
    // B: 동적 호출 ns.
    writeFileSync(
      path.join(srcRoot, 'b-widget.tsx'),
      `
        import { useTranslations } from 'next-intl';
        export function BWidget(status: string) {
          const t = useTranslations('nsB');
          return <div>{t(\`status_\${status}\`)}</div>;
        }
      `,
    );
    // A′: 번역자 파라미터를 통한 리터럴 — nsD의 bare 세그먼트('unnamedLabel')와 일치시킴.
    writeFileSync(
      path.join(srcRoot, 'helper.ts'),
      `
        export function label(t: (key: string) => string): string {
          return t('unnamedLabel');
        }
      `,
    );
    // C: 데이터 카탈로그 리터럴 — nsE의 bare 세그먼트('descFoo')와 일치시킴.
    writeFileSync(
      path.join(srcRoot, 'nav-config.ts'),
      `export const items = [{ descriptionKey: 'descFoo' }];`,
    );

    const koPath = path.join(dir, 'ko.json');
    const enPath = path.join(dir, 'en.json');
    const messages = {
      nsA: { label: '라벨' },
      nsB: { status_active: '활성' },
      nsC: { onlyOverlay: '오버레이 전용' }, // D로만 살아남아야 함.
      nsD: { unnamedLabel: '이름 없음' }, // A′로 살아남아야 함.
      nsE: { descFoo: '설명' }, // C로 살아남아야 함.
      nsDead: { orphanKey: '아무도 안 씀' }, // 넷 다 없음 — RED 대상.
    };
    writeFileSync(koPath, JSON.stringify(messages));
    writeFileSync(enPath, JSON.stringify(messages));

    const overlayAllowlistPath = path.join(dir, 'overlay.json');
    writeFileSync(overlayAllowlistPath, JSON.stringify({
      overlay_commit_sha: 'fixture', overlay_commit_date: '2026-01-01', namespaces: ['nsC'],
    }));

    return { dir, srcRoot, koPath, enPath, overlayAllowlistPath };
  }

  it('⭐임시 픽스처를 runScan()으로 끝까지 돌리면 A/A′/B/C/D 넷 다 각자 살리고 신호 0인 ns만 dead로 잡는다', () => {
    const f = makeFixture();
    try {
      const { deadNamespaces, topLevelNamespaces } = runScan({
        srcRoot: f.srcRoot, koPath: f.koPath, enPath: f.enPath, overlayAllowlistPath: f.overlayAllowlistPath, minExpectedFiles: 1,
      });
      expect(topLevelNamespaces).toEqual(new Set(['nsA', 'nsB', 'nsC', 'nsD', 'nsE', 'nsDead']));
      expect(deadNamespaces).toEqual(['nsDead']);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('⭐양성대조 — 죽은 ns 하나를 심으면(nsDead) RED 목록에 그 ns가 실제로 나온다', () => {
    // 위 테스트가 이미 이걸 확인하지만(nsDead 존재), 여기서는 "심으면 RED가 된다"를
    // 페드루 지시 문구 그대로 별도 표본으로 고정 — nsDead를 지워 GREEN으로 되돌아가는지까지.
    const f = makeFixture();
    try {
      const before = runScan({
        srcRoot: f.srcRoot, koPath: f.koPath, enPath: f.enPath, overlayAllowlistPath: f.overlayAllowlistPath, minExpectedFiles: 1,
      });
      expect(before.deadNamespaces).toContain('nsDead');

      // nsDead를 제거한 메시지로 다시 쓰고 재실행 — 이제 dead 후보가 0이어야 한다.
      const messagesWithoutDead = {
        nsA: { label: '라벨' }, nsB: { status_active: '활성' }, nsC: { onlyOverlay: 'x' },
        nsD: { unnamedLabel: 'x' }, nsE: { descFoo: 'x' },
      };
      writeFileSync(f.koPath, JSON.stringify(messagesWithoutDead));
      writeFileSync(f.enPath, JSON.stringify(messagesWithoutDead));
      const after = runScan({
        srcRoot: f.srcRoot, koPath: f.koPath, enPath: f.enPath, overlayAllowlistPath: f.overlayAllowlistPath, minExpectedFiles: 1,
      });
      expect(after.deadNamespaces).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('⭐양성대조 — 살아 있는 ns의 유일한 참조를 지우면 그 ns가 RED로 넘어간다', () => {
    const f = makeFixture();
    try {
      const before = runScan({
        srcRoot: f.srcRoot, koPath: f.koPath, enPath: f.enPath, overlayAllowlistPath: f.overlayAllowlistPath, minExpectedFiles: 1,
      });
      expect(before.deadNamespaces).not.toContain('nsA');

      // nsA를 참조하던 유일한 파일을 지운다(A층 신호 제거).
      rmSync(path.join(f.srcRoot, 'a-widget.tsx'));
      const after = runScan({
        srcRoot: f.srcRoot, koPath: f.koPath, enPath: f.enPath, overlayAllowlistPath: f.overlayAllowlistPath, minExpectedFiles: 1,
      });
      expect(after.deadNamespaces).toContain('nsA');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
