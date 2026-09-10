/**
 * story #3757(별건 ⑤) — i18n 「죽은 키」 messages→코드 역방향 최상위 ns 단위 가드.
 *
 * 기존 `check-i18n-keys.js`(#2371, 루트 스크립트, 정규식 기반)가 이미 이 방향(②)을
 * 시도했으나, 그 파서의 훅-바인딩 인식이 직접 `useTranslations()` 호출만 알고 유나
 * 표(v2/v3, `b8695901-8134-4767-ab35-db59071ab607`)가 "여섯 표기"로 부른 나머지 넷
 * (번역자 파라미터·call-signature 인터페이스·프로퍼티 접근·훅 반환 구조분해)을 몰라
 * `common.memberUnnamed`류를 대량으로 거짓 사망 처리했다(실측 2026-09-10: 정규식
 * 스캔 1174건 vs 이 파일이 재사용하는 TS AST 워커 159건). **`check-i18n-keys.js`는
 * 이 결함 클래스로 인해 폐기 대상**(이 스토리는 그 스크립트를 고치지 않는다 — PO 決
 * 2026-09-09, 카드에만 적고 별도 폐기 스토리로) — 이 파일이 대신 `verify-i18n-keys-exist.ts`
 * (#3754/#5ead8723, 여섯 표기 전부 검증된 TS AST 워커)를 새 기전 없이 재사용한다.
 *
 * ## 판정 — 최상위 네임스페이스 단위(키 단위 아님)
 * 아래 네 신호 중 하나라도 있으면 그 네임스페이스는 "참조됨"(GREEN):
 *   A/A′ — `scanRepo()`의 literalRefs 또는 unknownNsLiteralWords가 그 ns의 리프 키
 *          중 하나라도 가리킴(전체경로 또는 낱말 매치).
 *   B    — `scanRepo()`의 dynamicNamespaces에 그 ns가 있음(동적 호출 — 「참조됐는지
 *          알 수 없음」이지 「참조 안 됨」이 아니다, 유나 정의).
 *   C    — `KEY_FIELD_NAMES` 데이터 카탈로그 리터럴(`descriptionKey: 'x'`류)이 그 ns
 *          어딘가의 bare 세그먼트와 일치.
 *   D    — `i18n-overlay-consumed-namespaces.json`(비공개 SaaS 오버레이 정적 등재,
 *          아래 파일 참고 — CI가 그 저장소에 못 붙어 정적 스냅샷으로 대신한다)에 그
 *          ns 이름이 있음.
 * 넷 다 없으면 그 네임스페이스 전체가 죽었다 — RED. 허용목록 0건(fail-closed).
 *
 * ⚠️이 가드가 «키 단위» dead 판정은 아니다 — ns 전체가 완전히 안 열리는 극단만 잡는다.
 * 개별 키 단위 삭제 판정(A/B/C/D 신호가 하나라도 있는 ns 안에서 "이 특정 키"는 아직도
 * 안 쓰일 수 있음)은 사람이 스토리 본문에서 직접 읽는다(#3757 AC2, ⛔이 가드는 그 축을
 * 대신하지 않는다).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLeafKeys, scanRepo } from './verify-i18n-keys-exist';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const KO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');
const EN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/en.json');
const OVERLAY_ALLOWLIST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), './i18n-overlay-consumed-namespaces.json',
);

// story #3420(check-i18n-keys.js)와 같은 근거로 확인된 실 i18n-key-holding 필드 이름만
// 등재한다(grep 전수, 2026-09-10 — apiKey/authKey/storageKey류처럼 이름은 비슷해도
// `t(x.field)`로 소비되지 않는 필드는 제외했다). 새 필드가 생기면 여기 등재해야 이
// 층(C)이 잡는다 — 등재 없이는 그 필드를 쓰는 ns가 거짓 dead로 뜬다.
const KEY_FIELD_NAMES = ['labelKey', 'descriptionKey', 'descKey', 'statusKey', 'helpKey', 'argHintKey'];
const KEY_FIELD_RE = new RegExp(`\\b(?:${KEY_FIELD_NAMES.join('|')}):\\s*['"]([^'"]*)['"]`, 'g');

type MessageNode = string | { [key: string]: MessageNode };

const EXT_RE = /\.tsx?$/;
const TEST_RE = /\.test\.tsx?$/;

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkDir(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function collectTableBareKeys(srcRoot: string): Set<string> {
  const files: string[] = [];
  walkDir(srcRoot, files);
  const out = new Set<string>();
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    for (const m of content.matchAll(KEY_FIELD_RE)) {
      if (m[1] !== '') out.add(m[1]);
    }
  }
  return out;
}

export interface OverlayAllowlist {
  overlay_commit_sha: string;
  overlay_commit_date: string;
  namespaces: string[];
}

export function loadOverlayAllowlist(filePath: string): OverlayAllowlist {
  return JSON.parse(readFileSync(filePath, 'utf8')) as OverlayAllowlist;
}

export interface NamespaceReferenceInputs {
  topLevelNamespaces: Set<string>;
  literalRefFullKeys: Set<string>;
  dynamicNamespaces: Set<string>;
  unknownNsLiteralWords: Set<string>;
  tableBareKeys: Set<string>;
  overlayNamespaces: Set<string>;
  // 각 ns의 leaf 키(bare 세그먼트 포함) — unknownNsLiteralWords/tableBareKeys를 그 ns
  // 안에서 실제로 갖고 있는지 볼 때 필요.
  leafKeysByNamespace: Map<string, Set<string>>;
}

/** 네임스페이스 하나가 "참조됨"인지(A/A′/B/C/D 어느 신호든) 순수 판정 — self-test·main() 공용. */
export function isNamespaceReferenced(ns: string, inputs: NamespaceReferenceInputs): boolean {
  // A — 전체경로 리터럴 참조.
  const leaves = inputs.leafKeysByNamespace.get(ns) ?? new Set();
  for (const bare of leaves) {
    if (inputs.literalRefFullKeys.has(`${ns}.${bare}`)) return true;
  }
  // B — 동적 호출이 하나라도 있는 ns 전체 보류(참조 안 됨이 아니라 모름).
  if (inputs.dynamicNamespaces.has(ns)) return true;
  // A′ — unknown-ns 리터럴 낱말이 이 ns의 leaf bare 세그먼트와 일치.
  for (const bare of leaves) {
    if (inputs.unknownNsLiteralWords.has(bare)) return true;
  }
  // C — 데이터 카탈로그 리터럴이 이 ns의 leaf bare 세그먼트와 일치.
  for (const bare of leaves) {
    if (inputs.tableBareKeys.has(bare)) return true;
  }
  // D — SaaS 오버레이가 이 ns를 연다(정적 등재, 키 단위 아님 — ns 단위 가드의 스코프).
  if (inputs.overlayNamespaces.has(ns)) return true;
  return false;
}

// story #3757(카디르 qa:changes on #4107 동형 재발 방지) — 순수 판정 함수(isNamespaceReferenced)
// 유닛 테스트만으론 「main()이 그 함수를 실제로 이 파이프라인 안에서 부르는지」를 못 잰다
// (verify-no-i18n-phrase-collision.ts에서 실제로 겪은 결함 클래스 — 호출부를 지워도 유닛
// 테스트가 그대로 초록이었다). runScan에 경로 오버라이드를 열어 임시 픽스처 디렉터리로
// 이 함수 전체를 끝까지 돌리는 통합 테스트를 가능하게 한다(scanRepoCounts(dir) 동형 관례).
export function runScan(overrides: {
  srcRoot?: string; koPath?: string; enPath?: string; overlayAllowlistPath?: string;
  minExpectedFiles?: number;
} = {}): { deadNamespaces: string[]; topLevelNamespaces: Set<string> } {
  const srcRoot = overrides.srcRoot ?? SRC_ROOT;
  const koPath = overrides.koPath ?? KO_PATH;
  const enPath = overrides.enPath ?? EN_PATH;
  const overlayAllowlistPath = overrides.overlayAllowlistPath ?? OVERLAY_ALLOWLIST_PATH;

  const koMessages = JSON.parse(readFileSync(koPath, 'utf8')) as MessageNode;
  const enMessages = JSON.parse(readFileSync(enPath, 'utf8')) as MessageNode;
  const enLeaves = collectLeafKeys(enMessages);
  const koLeaves = collectLeafKeys(koMessages);

  const topLevelNamespaces = new Set<string>();
  const leafKeysByNamespace = new Map<string, Set<string>>();
  for (const leaf of new Set([...enLeaves, ...koLeaves])) {
    const dotIdx = leaf.indexOf('.');
    const ns = dotIdx === -1 ? leaf : leaf.slice(0, dotIdx);
    const bare = leaf.slice(leaf.lastIndexOf('.') + 1);
    topLevelNamespaces.add(ns);
    if (!leafKeysByNamespace.has(ns)) leafKeysByNamespace.set(ns, new Set());
    leafKeysByNamespace.get(ns)!.add(bare);
  }

  const scan = overrides.minExpectedFiles !== undefined
    ? scanRepo(srcRoot, overrides.minExpectedFiles)
    : scanRepo(srcRoot);
  const literalRefFullKeys = new Set(scan.literalRefs.map((r) => r.fullKey));
  const tableBareKeys = collectTableBareKeys(srcRoot);
  const overlay = loadOverlayAllowlist(overlayAllowlistPath);
  const overlayNamespaces = new Set(overlay.namespaces);

  const inputs: NamespaceReferenceInputs = {
    topLevelNamespaces,
    literalRefFullKeys,
    dynamicNamespaces: scan.dynamicNamespaces,
    unknownNsLiteralWords: scan.unknownNsLiteralWords,
    tableBareKeys,
    overlayNamespaces,
    leafKeysByNamespace,
  };

  const deadNamespaces = [...topLevelNamespaces].filter((ns) => !isNamespaceReferenced(ns, inputs));
  return { deadNamespaces, topLevelNamespaces };
}

function main(): number {
  const { deadNamespaces, topLevelNamespaces } = runScan();

  console.log(
    `[가드] i18n 네임스페이스 참조 스캔 — 네임스페이스 ${topLevelNamespaces.size}개 ` +
      `(SaaS 오버레이 스냅샷 — 잠정치, i18n-overlay-consumed-namespaces.json 만료조건 참고)`,
  );

  if (deadNamespaces.length > 0) {
    console.error(`\nFAIL: 참조 신호가 A/A′/B/C/D 어디에도 없는 네임스페이스 ${deadNamespaces.length}개:`);
    for (const ns of deadNamespaces.sort()) console.error(`  ${ns}`);
    console.error(
      '\n→ 이 네임스페이스는 OSS 코드·SaaS 오버레이(정적 스냅샷) 어디서도 안 열린다 — 죽은 ' +
        'ns 후보(키 단위 삭제 판정은 별도, story #3757 AC2). 허용목록 0건(fail-closed) — ' +
        '정말 살아 있다면 위 네 신호 중 하나가 이 ns를 잡게 만들 것(overlay라면 ' +
        'i18n-overlay-consumed-namespaces.json 재측정 후 등재).',
    );
    return 1;
  }

  console.log('\nOK: 모든 최상위 네임스페이스가 A/A′/B/C/D 중 하나 이상의 신호로 참조됨.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
