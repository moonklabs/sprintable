/**
 * story #3880(§⑤ 낱말 드리프트) AC2(b) — verify-no-raw-ascii-jsx-text.ts(story #3876,
 * JSX 구조를 본다)의 자매 가드지만 축이 다르다: 이건 **i18n 값 콘텐츠**를 본다. 실 사고:
 * `docs.indexKicker`="지식 · KNOWLEDGE BASE"는 `t('indexKicker')`로 정상 경유하는데
 * (구조는 무결) ko.json 값 자체에 영단어가 baked-in — 키 존재·t() 경유 검사로는
 * 원리상 못 잡는 클래스(어떤 JSX 구조 가드도 값 안을 안 본다).
 *
 * ## 기전 — messages/ko.json을 재귀 순회, 모든 leaf 문자열 값에서 `\b[A-Z]{2,}\b`(대문자
 * 2자 이상 토큰) 검출. en.json은 대상 밖(원문이 영어라 당연히 대문자 토큰이 있다 —
 * ko 로케일에서만 "영단어가 샌다"는 문제가 성립).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AsciiTokenRef {
  key: string;
  value: string;
  token: string;
}

const CAPS_TOKEN_RE = /\b[A-Z]{2,}\b/g;

function flatten(obj: Record<string, unknown>, prefix: string, out: Map<string, string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const qualifiedKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, qualifiedKey, out);
    } else if (typeof v === 'string') {
      out.set(qualifiedKey, v);
    }
  }
}

export function scanKoValues(koJson: Record<string, unknown>): AsciiTokenRef[] {
  const flat = new Map<string, string>();
  flatten(koJson, '', flat);

  const refs: AsciiTokenRef[] = [];
  for (const [key, value] of flat) {
    const matches = value.match(CAPS_TOKEN_RE);
    if (!matches) continue;
    for (const token of new Set(matches)) {
      refs.push({ key, value, token });
    }
  }
  return refs;
}

/** ref의 안정 키 — i18n 키+토큰(값 전체가 아니라 — 값의 다른 부분이 바뀌어도 같은
 * 토큰이 남아있으면 같은 자리로 식별). */
export function refKey(r: Pick<AsciiTokenRef, 'key' | 'token'>): string {
  return `${r.key}::${r.token}`;
}

// ALLOWLIST — 영구 예외(§⑤ 허용 액센트·브랜드·단위·기술 식별자). story #3880 PO 確定
// (2026-09-14 15:47Z) — 목표 상세 eyebrow 3 + 목표 목록 킥커는 "한국어 낱말 · 영문
// 대문자 proof-단계 스탬프" 패턴이 §⑤가 허용하는 액센트(증명 시스템 시그니처, 내부어
// 누출 아님) — 3880 스코프 밖, 변경 0.
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'goals.taskCapsuleTitle::CLAIMED',
  'goals.outcomeCapsuleTitle::VERIFIED',
  'goals.trustRailTitle::TRUST',
  'goals.indexKicker::OUTCOMES',
]);

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ascii-token-in-ko-value-baseline.json');

interface BaselineFile {
  _comment: string[];
  keys: string[];
}

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Set(parsed.keys ?? []);
  } catch {
    return new Set();
  }
}

export function computeNewViolations(refs: AsciiTokenRef[], allowlist: ReadonlySet<string>, baseline: ReadonlySet<string>): AsciiTokenRef[] {
  return refs.filter((r) => {
    const key = refKey(r);
    return !allowlist.has(key) && !baseline.has(key);
  });
}

export function computeStaleBaseline(refs: AsciiTokenRef[], baseline: ReadonlySet<string>): string[] {
  const foundKeys = new Set(refs.map(refKey));
  return [...baseline].filter((k) => !foundKeys.has(k));
}

const MIN_EXPECTED_KEYS = 3000;

export function loadKoJson(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function main(): number {
  let koJson: Record<string, unknown>;
  try {
    koJson = loadKoJson(KO_JSON_PATH);
  } catch (e) {
    console.error(`FAIL: messages/ko.json을 못 읽음 — ${(e as Error).message}`);
    return 1;
  }

  const flatCount = (() => {
    const m = new Map<string, string>();
    flatten(koJson, '', m);
    return m.size;
  })();
  if (flatCount < MIN_EXPECTED_KEYS) {
    console.error(`FAIL: ko.json에서 leaf 문자열 키가 ${flatCount}개뿐 — 이 가드가 헛돌고 있다.`);
    return 1;
  }

  const refs = scanKoValues(koJson);
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = computeNewViolations(refs, ALLOWLIST, baseline);
  const staleBaseline = computeStaleBaseline(refs.filter((r) => !ALLOWLIST.has(refKey(r))), baseline);

  console.log(
    `[story #3880 AC2(b)] ko.json 값 콘텐츠 순 ASCII 대문자 토큰 스캔 — leaf 키 ${flatCount}개 · ` +
      `검출 ${refs.length}건 · ALLOWLIST ${ALLOWLIST.size}건 · baseline(grandfather) ${baseline.size}건 · ` +
      `신규 ${newViolations.length}건 · stale ${staleBaseline.length}건`,
  );

  let failed = false;

  if (newViolations.length > 0) {
    failed = true;
    console.error('\nFAIL: ALLOWLIST/baseline에 없는 ko.json 값 안 순 ASCII 대문자 토큰 발견:');
    for (const r of newViolations.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${r.key}="${r.value}" (토큰: ${r.token})`);
    }
    console.error(
      '\n→ 한국어 낱말로 옮길 것 — 새 낱말이 필요하면 §⑤ 낱말 표를 먼저 확定(유나) 한 뒤 반영. ' +
        '정말 번역 대상이 아니면(브랜드·단위·§⑤ 허용 액센트 등) ALLOWLIST에 사유와 함께 등재(PO 승인), ' +
        '이 카드 스코프 밖이면 baseline에 등재(PO 승인).',
    );
  }

  if (staleBaseline.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline에 ${staleBaseline.length}건이 등재됐으나 이번 스캔에서 안 걸렸다:`);
    for (const k of staleBaseline.sort()) console.error(`  - ${k}`);
    console.error('\n→ 고쳐졌다면(한국어로 옮겼거나 삭제했다면) baseline에서 그 항목을 지울 것.');
  }

  if (failed) return 1;

  console.log('\nOK: ALLOWLIST/baseline 초과 없음(신규 0건) · stale 0건(죽은 baseline 항목 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const koJson = loadKoJson(KO_JSON_PATH);
    const refs = scanKoValues(koJson).filter((r) => !ALLOWLIST.has(refKey(r)));
    const keys = [...new Set(refs.map(refKey))].sort();
    const out: BaselineFile = {
      _comment: [
        'story #3880(§⑤ 낱말 드리프트) grandfather baseline — 이 가드 첫 도입 시점 develop의',
        '기존 ko.json 값 안 순 ASCII 대문자 토큰 잔존분(이 카드 스코프 밖 — 기술 약어·고유명사·',
        '내부 화면 등 개별 판단 필요, 전량 정리는 후속 별건). "더 늘지 않는다"만 보장.',
      ],
      keys,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
