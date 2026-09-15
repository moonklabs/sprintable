/**
 * story #3894 — 사용자 문장 안에 역할 낱말이 영어 슬러그(`owner`/`admin`)로 남는 클래스를
 * 막는다. channelConnect 정본이 「소유자」·「관리자」로 확定됐는데 content/organization/
 * pricingPlans/contentRules 값 일부가 아직 `owner`/`admin` ASCII를 그대로 노출하고 있었다
 * (같은 사실을 두 낱말로 — same-fact-two-words). #3880 계열 가드(verify-no-ascii-token-
 * in-ko-value.ts)는 대문자 토큰(`\b[A-Z]{2,}\b`)·값 전체 순 ASCII만 봐서 소문자 `owner`/
 * `admin`이 한국어 문장에 섞인 자리는 원리상 못 잡는다 — 축이 다른 자매 가드다.
 *
 * ## 기전 — messages/ko.json에서 `content`·`organization`·`pricingPlans`·`contentRules`·
 * `settings` 네임스페이스만 재귀 순회, leaf 문자열 값에서 단어경계 소문자 슬러그
 * `\b(owner|admin)\b`(ASCII)를 검출. 자리(키 경로)가 ALLOWLIST에 있으면 예외 — 사용자가
 * 역할 필드에 실제로 타이핑하는 리터럴 슬러그를 예시로 보여주는 placeholder는 정당한
 * 노출이라 허용한다.
 *
 * ## 대상 네임스페이스를 한정한 이유 — 영어 UI(en.json)나 기술 키(로그·이벤트명 등)까지
 * 훑으면 오탐이 는다. 이 카드가 확定한 «사용자 문장» 표면은 이 네임스페이스들뿐이라 스코프를
 * 거기로 고정한다. settings는 #3892(PR #4295)가 settings.* 역할 낱말을 소유자/관리자로
 * 정리해 develop에 착지한 뒤 승격됐다(그 전에 넣었으면 settings 잔존 슬러그로 CI RED).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RoleSlugRef {
  key: string;
  value: string;
  slug: string;
}

// 이 카드가 확定한 «사용자 문장» 네임스페이스 — 여기 값만 검사한다.
// settings는 #3892(PR #4295)가 settings.* 역할 낱말을 소유자/관리자로 정리한 뒤 승격됐다
// (그 전에 넣었으면 CI RED였다 — 만료 조건: #4295 develop 착지).
export const TARGET_NAMESPACES: readonly string[] = ['content', 'organization', 'pricingPlans', 'contentRules', 'settings'];

// 단어경계 소문자 ASCII 슬러그. Korean 음절·`/`·`·`(middot)·공백은 전부 non-word라
// "owner/admin"·"owner·admin"·"owner가"·"조직 owner에게" 모두 매칭된다. 대문자(Owner)나
// 부분 문자열(coowner·administrator)은 매칭 안 된다(standalone lowercase only).
const ROLE_SLUG_RE = /\b(owner|admin)\b/g;

// ALLOWLIST — 자리(키 경로) 단위 영구 예외. 사용자가 역할 필드에 실제로 입력하는 리터럴
// 슬러그를 예시로 보여주는 placeholder(값에 "예: owner, admin"). 여기서 `owner`/`admin`은
// 번역 대상 낱말이 아니라 사용자가 그대로 타이핑하는 입력값 예시라 정당한 노출이다.
// (합 4개 슬러그 occurrence — 각 키당 owner·admin 2개씩.)
export const ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'organization.eventActionAuthRolePlaceholder',
  'organization.definerAuthRolesPlaceholder',
]);

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

/** 대상 4개 네임스페이스의 leaf 문자열만 dot-path로 평탄화. */
export function flattenTargetNamespaces(koJson: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const ns of TARGET_NAMESPACES) {
    const nsObj = koJson[ns];
    if (nsObj !== null && typeof nsObj === 'object' && !Array.isArray(nsObj)) {
      flatten(nsObj as Record<string, unknown>, ns, out);
    }
  }
  return out;
}

/** 대상 네임스페이스 값에서 단어경계 소문자 슬러그(owner/admin)를 전수 검출 —
 * 값 안에 여러 개면 각각(중복 제거). ALLOWLIST 필터는 computeViolations가 담당. */
export function scanRoleSlugs(koJson: Record<string, unknown>): RoleSlugRef[] {
  const flat = flattenTargetNamespaces(koJson);
  const refs: RoleSlugRef[] = [];
  for (const [key, value] of flat) {
    const matches = value.match(ROLE_SLUG_RE);
    if (!matches) continue;
    for (const slug of new Set(matches)) {
      refs.push({ key, value, slug });
    }
  }
  return refs;
}

/** ALLOWLIST에 없는 자리의 슬러그만 위반으로 남긴다. */
export function computeViolations(refs: RoleSlugRef[], allowlist: ReadonlySet<string>): RoleSlugRef[] {
  return refs.filter((r) => !allowlist.has(r.key));
}

const KO_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages/ko.json');

// self-assert — 대상 네임스페이스가 비정상적으로 얇으면(리네임/삭제로 스캔 경로가 헛돈
// 것) 조용한 «위반 0» 대신 죽는다(#3164/#2710류 fail-loud 관례).
const MIN_EXPECTED_LEAVES = 50;

export function loadKoJson(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function main(): number {
  let koJson: Record<string, unknown>;
  try {
    koJson = loadKoJson(KO_JSON_PATH);
  } catch (e) {
    // fail-loud: 못 읽음 ≠ 위반 0.
    console.error(`FAIL: messages/ko.json을 못 읽거나 파싱 실패 — ${(e as Error).message} (경로=${KO_JSON_PATH})`);
    return 1;
  }

  const flat = flattenTargetNamespaces(koJson);
  if (flat.size < MIN_EXPECTED_LEAVES) {
    console.error(
      `FAIL: 대상 네임스페이스(${TARGET_NAMESPACES.join('·')})에서 leaf 문자열이 ${flat.size}개뿐 — ` +
        '이 가드가 헛돌고 있다(네임스페이스가 리네임/삭제됐거나 스캔 경로가 헛돔).',
    );
    return 1;
  }

  const refs = scanRoleSlugs(koJson);
  const violations = computeViolations(refs, ALLOWLIST);

  console.log(
    `[story #3894] 사용자 문장 역할 슬러그(owner/admin) 스캔 — 대상 네임스페이스 ${TARGET_NAMESPACES.length}개 · ` +
      `leaf ${flat.size}개 · 검출 ${refs.length}건 · ALLOWLIST ${ALLOWLIST.size}건 · 위반 ${violations.length}건`,
  );

  if (violations.length > 0) {
    console.error('\nFAIL: 사용자 문장 값 안에 영어 역할 슬러그(owner/admin) 발견 — 한국어 정본(소유자/관리자)으로 옮길 것:');
    for (const r of violations.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`  - ${r.key}="${r.value}" (슬러그: ${r.slug})`);
    }
    console.error(
      '\n→ channelConnect 정본대로 owner→소유자 · admin→관리자로 치환할 것(조사 정합 주의: owner·admin이→소유자·관리자가). ' +
        '사용자가 역할 필드에 그대로 입력하는 리터럴 예시(placeholder)라면 이 스크립트의 ALLOWLIST에 사유와 함께 등재(PO 승인).',
    );
    return 1;
  }

  console.log('\nOK: 대상 네임스페이스 사용자 문장에 영어 역할 슬러그(owner/admin) 없음(ALLOWLIST 예외 제외).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
