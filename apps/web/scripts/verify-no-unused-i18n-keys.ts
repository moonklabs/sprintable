/**
 * story #3732(3728 (A) 후속) — i18n 「죽은 키」 messages→코드 역방향 **키 단위** 가드.
 *
 * `verify-i18n-namespace-referenced.ts`(#3757)가 이미 같은 방향을 **네임스페이스 단위**로
 * 커버한다(A/A′/B/C/D 신호, `scanRepo()`+`isDynamicallyComposed`류 재사용) — 그 가드는
 * "이 ns가 통째로 안 열리는 극단"만 잡고, "열려 있는 ns 안의 특정 키 하나가 안 쓰인다"는
 * 사람이 직접 읽으라고 명시적으로 스코프 밖에 둔다(#3757 AC2 docstring). 이 스토리(#3732)가
 * 그 남은 축 — 키 단위 — 을 채운다.
 *
 * ⛔새 기전 발명 금지(2026-09-09 PO 판정, verify-i18n-keys-exist.ts:223-234 재확인 후
 * 2026-09-22 재승인 — ts.Program+TypeChecker whole-program 설계는 그라운딩만 남기고 폐기,
 * story #3732 카드 코멘트 참조) — 이 파일은 새 AST 워커를 만들지 않는다. `verify-i18n-keys-
 * exist.ts`(#5ead8723)의 `scanRepo()`가 이미 파일 단위 AST walk로 뽑아 둔 재료(literalRefs·
 * indirectLookupRefs·unknownNsLiteralWords·indirectLookupWords)를 그대로 소비한다.
 *
 * ## 판정 — 키 단위(전체 dot-path)
 * en.json의 리프 키마다, 아래 신호 중 하나라도 있으면 "참조됨"(살아 있음):
 *   A  — `literalRefs`(직접 `t('key')`/`t.rich/.raw/.has`)가 그 전체경로를 가리킴.
 *   A″ — `indirectLookupRefs`(번역자 co-argument·Record<string,string> 테이블값, ns를
 *        아는 경우만 — verify-i18n-keys-exist.ts 층 A″)가 그 전체경로를 가리킴.
 *   A′/A″-word — `unknownNsLiteralWords`(번역자 파라미터/훅 반환 등 ns를 모르는 호출)나
 *        `indirectLookupWords`(ns를 모르는 co-argument/테이블값)가 그 키의 **말단
 *        세그먼트**와 일치. ns를 모르니 전체경로로는 못 좁히고 관대한 낱말 축으로만
 *        본다(동음이의 오탐 방지는 이 축의 태생적 한계 — verify-i18n-keys-exist.ts와
 *        동일 트레이드오프, #3757 A′와 동형).
 *   B  — `check-i18n-keys.js`의 `DYNAMIC_KEY_PREFIXES`(정밀 접두사 화이트리스트,
 *        `t(\`prefix_${var}\`)`류 — #2371) 대상.
 *   E  — `TEMPLATE_KEY_TABLE`(#2228, apps/web/src/lib/i18n-template-key-table.ts) 전개값.
 * 다섯 다 없으면 죽은-키 후보 — fail-closed. 죽었다고 **못** 판정하는 쪽(위 신호가 하나라도
 * 있으면 산다)으로 기운다 — PO 처방(2026-09-22): "unknown-ns 버킷은 «죽었다고 못 판정»으로
 * 두는 게 맞다."
 *
 * ⚠️ 의도적으로 안 쓰는 신호: `scanRepo().dynamicNamespaces`(ns 전체를 동적 호출 하나로
 * 통째로 보류하는 #3757 층B)는 여기 안 쓴다 — 키 단위 가드에서 그걸 쓰면 "이 ns 안 아무
 * 동적 호출 하나"가 그 ns의 모든 미참조 키를 조용히 살려 정밀도가 namespace 가드로
 * 퇴화한다. 대신 DYNAMIC_KEY_PREFIXES(B, 정확한 접두사만)를 쓴다 — "ns를 알 수 있으면
 * 반드시 전체경로/접두사로 좁힌다"는 정밀도 원칙(verify-i18n-keys-exist.ts A″ docstring)을
 * 그대로 물려받는다. 이 좁힘 때문에 진짜 동적이지만 아직 표에 없는 자리(TEMPLATE_KEY_TABLE
 * 자신의 kitOrientingWakeBody_ 사례처럼)는 죽은-키 후보로 한 번 뜬다 — grandfather
 * baseline이 그 진짜 갭과 진짜 죽은 키를 같이 사람이 검토하게 만드는 지점(의도된 동작,
 * 조용히 사각 처리하지 않는다).
 *
 * ## grandfather baseline(AC1 "카운트-핀·사유")
 * `i18n-dead-key-baseline.json` — 최초 스캔 스냅샷. 새 죽은-키 후보(baseline 밖)는 fail.
 * baseline에 있었는데 이제 죽은-키 후보가 아닌 항목(누가 쓰기 시작했거나 messages에서
 * 지워짐)은 stale로 fail — 가만히 낡게 두지 않는다(이 저장소 다른 grandfather 가드들과
 * 동일 규율, 예: verify_no_new_korean_user_strings.py).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLeafKeys, scanRepo } from './verify-i18n-keys-exist';
// story #3732 — packages/scripts/(Docker 빌드 컨텍스트 안, i18n-key-parser.js와 동일 선례)
// 에서 import한다. 저장소 루트 scripts/check-i18n-keys.js에서 직접 import했더니
// verify-frontend-docker-import-context.ts(#3731·#3729)가 "빌드 컨텍스트 밖 참조"로
// fail-closed 걸렸다 — DYNAMIC_KEY_PREFIXES/isDynamicallyComposed를 packages/scripts/
// i18n-dynamic-key-prefixes.js로 이관해 두 소비처(check-i18n-keys.js·이 파일)가 같이 본다.
import { isDynamicallyComposed } from '../../../packages/scripts/i18n-dynamic-key-prefixes.js';
import { TEMPLATE_KEY_TABLE } from '../src/lib/i18n-template-key-table';

type MessageNode = string | { [key: string]: MessageNode };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');
const EN_PATH = path.resolve(HERE, '../messages/en.json');
const BASELINE_PATH = path.resolve(HERE, 'i18n-dead-key-baseline.json');

export interface DeadKeyBaselineEntry {
  key: string;
  reason: string;
}

export function loadBaseline(filePath: string): DeadKeyBaselineEntry[] {
  return JSON.parse(readFileSync(filePath, 'utf8')) as DeadKeyBaselineEntry[];
}

const templateKeySet = new Set<string>();
for (const [prefix, values] of TEMPLATE_KEY_TABLE) {
  for (const v of values) templateKeySet.add(`${prefix}${v}`);
}

export interface DeadKeyScanInputs {
  enLeaves: Set<string>;
  literalRefFullKeys: Set<string>;
  indirectLookupRefFullKeys: Set<string>;
  unknownNsLiteralWords: Set<string>;
  indirectLookupWords: Set<string>;
}

/** 리프 키 하나가 "참조됨"인지(A/A″/A′/A″-word/B/E 신호 중 하나) 순수 판정 — self-test·main() 공용. */
export function isKeyReferenced(flatKey: string, inputs: DeadKeyScanInputs): boolean {
  if (inputs.literalRefFullKeys.has(flatKey)) return true; // A
  if (inputs.indirectLookupRefFullKeys.has(flatKey)) return true; // A″
  const bare = flatKey.slice(flatKey.lastIndexOf('.') + 1);
  if (inputs.unknownNsLiteralWords.has(bare)) return true; // A′
  if (inputs.indirectLookupWords.has(bare)) return true; // A″-word
  if (isDynamicallyComposed(flatKey)) return true; // B
  if (templateKeySet.has(flatKey)) return true; // E
  return false;
}

export function runScan(overrides: { srcRoot?: string; enPath?: string; minExpectedFiles?: number } = {}): {
  deadCandidates: string[];
  enLeaves: Set<string>;
} {
  const srcRoot = overrides.srcRoot ?? SRC_ROOT;
  const enPath = overrides.enPath ?? EN_PATH;

  const enMessages = JSON.parse(readFileSync(enPath, 'utf8')) as MessageNode;
  // en.json을 SSOT로 순회(check-i18n-keys.js·verify-i18n-keys-exist.ts와 동일 관례 — ko/en
  // 말단 키 집합 짝은 verify-i18n-keys-exist.ts가 이미 별도로 지킨다, 이 가드는 "코드가
  // 안 읽는다"만 잰다).
  const enLeaves = collectLeafKeys(enMessages);

  const scan = overrides.minExpectedFiles !== undefined
    ? scanRepo(srcRoot, overrides.minExpectedFiles)
    : scanRepo(srcRoot);

  const inputs: DeadKeyScanInputs = {
    enLeaves,
    literalRefFullKeys: new Set(scan.literalRefs.map((r) => r.fullKey)),
    indirectLookupRefFullKeys: new Set(scan.indirectLookupRefs.map((r) => r.fullKey)),
    unknownNsLiteralWords: scan.unknownNsLiteralWords,
    indirectLookupWords: scan.indirectLookupWords,
  };

  const deadCandidates = [...enLeaves].filter((k) => !isKeyReferenced(k, inputs)).sort();
  return { deadCandidates, enLeaves };
}

function main(): number {
  const { deadCandidates, enLeaves } = runScan();
  const baseline = loadBaseline(BASELINE_PATH);
  const baselineSet = new Set(baseline.map((e) => e.key));
  const deadSet = new Set(deadCandidates);

  const newDead = deadCandidates.filter((k) => !baselineSet.has(k));
  const stale = baseline.filter((e) => !deadSet.has(e.key));

  console.log(
    `[가드] i18n 키 단위 dead-key 스캔 — en 말단 ${enLeaves.size}개 · 죽은-키 후보 ${deadCandidates.length}건 ` +
      `· baseline ${baseline.length}건(grandfather)`,
  );

  let failed = false;

  if (newDead.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline 밖의 신규 죽은-키 후보 ${newDead.length}건:`);
    for (const k of newDead) console.error(`  ${k}`);
    console.error(
      '\n→ 코드 어디서도 이 키를 안 읽는다(literal·co-argument·테이블값·unknown-ns 낱말·' +
        'DYNAMIC_KEY_PREFIXES·TEMPLATE_KEY_TABLE 전부 미매치). 실제로 안 쓰면 messages에서' +
        '지우고, 쓰는데 이 가드가 오판했으면(새 소비 형태) i18n-dead-key-baseline.json에' +
        '사유와 함께 등재하거나 verify-i18n-keys-exist.ts의 신호 축을 넓힐 것(발견되면 새' +
        '기전 없이 기존 축 확장 — #5ead8723 ③⑤⑥ 관례).',
    );
  }

  if (stale.length > 0) {
    failed = true;
    console.error(`\nFAIL: baseline에 있지만 더 이상 죽은-키 후보가 아닌 ${stale.length}건(stale):`);
    for (const e of stale) console.error(`  ${e.key} (${e.reason})`);
    console.error('\n→ 코드가 쓰기 시작했거나 messages에서 삭제됨 — baseline에서 빼야 한다(낡게 두지 않는다).');
  }

  if (failed) return 1;

  console.log('\nOK: 신규 죽은-키 후보 0건 · baseline stale 0건.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
