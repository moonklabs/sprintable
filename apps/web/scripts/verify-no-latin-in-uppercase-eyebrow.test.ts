import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWLIST,
  computeNewViolations,
  computeStaleBaseline,
  flattenKo,
  latinViolations,
  loadBaseline,
  loadKoJson,
  refKey,
  scanContentForEyebrows,
  scanRepo,
  type UppercaseEyebrowRef,
} from './verify-no-latin-in-uppercase-eyebrow';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'latin-in-uppercase-eyebrow-baseline.json');

function refsFor(value: string, key = 'ns.key', file = 'fake.tsx', line = 1): UppercaseEyebrowRef[] {
  return [{ file, line, key, value }];
}

describe('scanContentForEyebrows — story #3925 셀프테스트', () => {
  it('⭐uppercase 클래스 + {t(\'key\')} 짝(한 줄) → 검출', () => {
    const src = `function C() { const t = useTranslations('ns'); return <div className="text-xs uppercase">{t('kicker')}</div>; }`;
    const found = scanContentForEyebrows(src, 'fake.tsx');
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe('ns.kicker');
  });

  it('⭐uppercase 클래스 + {t(\'key\')}가 여러 줄(형제 프로젝트 실 패턴)에 걸쳐도 검출', () => {
    const src = `
      function C() {
        const t = useTranslations('attentionQueue');
        return (
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-proof-ink-3">
            {t('kicker')}
          </div>
        );
      }
    `;
    const found = scanContentForEyebrows(src, 'fake.tsx');
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe('attentionQueue.kicker');
  });

  it('음성대조 — uppercase 없는 className은 GREEN', () => {
    const src = `function C() { const t = useTranslations('ns'); return <div className="text-xs">{t('kicker')}</div>; }`;
    expect(scanContentForEyebrows(src, 'fake.tsx')).toEqual([]);
  });

  it('음성대조 — t() 호출이 아예 없는 uppercase 엘리먼트는 GREEN', () => {
    const src = `function C() { return <div className="uppercase">고정 텍스트</div>; }`;
    expect(scanContentForEyebrows(src, 'fake.tsx')).toEqual([]);
  });

  it('음성대조 — self-closing 엘리먼트(자식 없음)는 uppercase여도 GREEN', () => {
    const src = `function C() { const t = useTranslations('ns'); return <input className="uppercase" placeholder={t('kicker')} />; }`;
    expect(scanContentForEyebrows(src, 'fake.tsx')).toEqual([]);
  });

  it('음성대조 — useTranslations 바인딩 없이 부르는 t()는 네임스페이스를 몰라 GREEN(안전한 쪽 누락)', () => {
    const src = `function C() { return <div className="uppercase">{t('kicker')}</div>; }`;
    expect(scanContentForEyebrows(src, 'fake.tsx')).toEqual([]);
  });

  it('바인딩 변수명이 t가 아니어도(tc·tOutcome 등) 잡는다', () => {
    const src = `function C() { const tc = useTranslations('common'); return <div className="uppercase">{tc('kicker')}</div>; }`;
    const found = scanContentForEyebrows(src, 'fake.tsx');
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe('common.kicker');
  });
});

describe('latinViolations — 플레이스홀더 제외(뮤테이션 대조)', () => {
  it('⭐라틴 문자가 실제로 있으면 검출', () => {
    expect(latinViolations(refsFor('Attention Queue'))).toHaveLength(1);
  });

  it('뮤테이션 대조 — 값 전체가 한국어면 GREEN', () => {
    expect(latinViolations(refsFor('오늘'))).toEqual([]);
  });

  it('플레이스홀더 {n}·{org} 안의 라틴 문자는 "노출된 영문"이 아니라 GREEN(렌더 시 데이터로 치환)', () => {
    expect(latinViolations(refsFor('다음이 비어 있는 목표 — {n}개'))).toEqual([]);
    expect(latinViolations(refsFor('{org} · 프로젝트'))).toEqual([]);
  });

  it('플레이스홀더 밖의 라틴 문자는 플레이스홀더가 있어도 여전히 검출', () => {
    expect(latinViolations(refsFor('{n}개 · Latin 텍스트'))).toHaveLength(1);
  });
});

describe('computeNewViolations / computeStaleBaseline — 실 파일 뮤테이션 양성대조', () => {
  const originalKo = loadKoJson(KO_JSON_PATH);
  const baseline = loadBaseline(BASELINE_PATH);

  it('전제: 원본 recruiter.scopeTitle은 이미 한국어(GREEN)', () => {
    const koFlat = flattenKo(originalKo as Record<string, unknown>);
    expect(koFlat.get('recruiter.scopeTitle')).toBe('스코프 키 권한');
  });

  it('되돌리면("scoped key 권한") RED — 이 카드가 실제로 고친 자리를 가드가 지킨다', () => {
    const refs: UppercaseEyebrowRef[] = [
      { file: 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx', line: 1408, key: 'recruiter.scopeTitle', value: 'scoped key 권한' },
    ];
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    expect(newViolations).toHaveLength(1);
  });

  it('원복하면(스코프 키 권한) GREEN', () => {
    const refs: UppercaseEyebrowRef[] = [
      { file: 'app/(authenticated)/organization/workforce/recruiter/recruiter-client.tsx', line: 1408, key: 'recruiter.scopeTitle', value: '스코프 키 권한' },
    ];
    expect(computeNewViolations(refs, ALLOWLIST, baseline)).toEqual([]);
  });

  it('baseline에 없는 항목이 검출에서 사라지면 stale로 잡힌다', () => {
    const refs: UppercaseEyebrowRef[] = [];
    const stale = computeStaleBaseline(refs, new Set(['zzz.notReal']));
    expect(stale).toEqual(['zzz.notReal']);
  });
});

describe('scanRepo — story #3925(실 트리 실행)', () => {
  it('실 ko.json — ALLOWLIST+baseline과 정확히 일치(신규 0·stale 0)', () => {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanRepo(SRC_ROOT, koJson);
    expect(refs.length).toBeGreaterThan(0);
    const baseline = loadBaseline(BASELINE_PATH);
    const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
    const staleBaseline = computeStaleBaseline(refs, baseline);
    expect(newViolations).toEqual([]);
    expect(staleBaseline).toEqual([]);
  });

  it('무관 PR 표본 — 이 가드 대상이 아닌 값(라틴 0)만 바뀌어도 위반 0(exit 0 동형)', () => {
    const fixture = { some: { newKey: '평범한 한국어 문구' } };
    const koFlat = flattenKo(fixture);
    expect(koFlat.get('some.newKey')).toBe('평범한 한국어 문구');
    const refs = refsFor('평범한 한국어 문구', 'some.newKey');
    expect(latinViolations(refs)).toEqual([]);
  });
});

describe('refKey — 안정 키(라인 번호 무관)', () => {
  it('같은 키면 라인이 달라져도 같은 refKey(무관 PR의 줄 밀림에 안 흔들림)', () => {
    const a = refsFor('Test', 'ns.key', 'f.tsx', 10)[0]!;
    const b = refsFor('Test', 'ns.key', 'f.tsx', 55)[0]!;
    expect(refKey(a)).toBe(refKey(b));
  });
});

// 실 파일 확認 — ALLOWLIST 4개(goals 스탬프)가 실제로 현재 uppercase eyebrow 라틴 노출
// 리스트에 있는지(등재 사유의 전제).
describe('ALLOWLIST — goals 스탬프 4개가 실제로 이 축에 걸리는 자리인지 확認', () => {
  it('4개 전부 실 소비처 파일에 uppercase 클래스로 존재', () => {
    const files = [
      'app/(authenticated)/[ws]/[proj]/goals/[id]/page.tsx',
      'app/(authenticated)/[ws]/[proj]/goals/goals-client.tsx',
      'components/goals/goal-trust-rail.tsx',
    ];
    for (const f of files) {
      const content = readFileSync(path.join(SRC_ROOT, f), 'utf8');
      expect(content).toContain('uppercase');
    }
    expect(ALLOWLIST.size).toBe(5);
  });
});
