/**
 * story #2367 회귀가드 — 「같은 파일이 렌더하는 두 문구가, «수와 함께 서는» 자리에서 부분
 * 문자열로 겹치면」CI가 잡는다. #2352(「막힘 28」↔「막힘 0」)·#2365(「승인 대기 30」↔「승인
 * 대기」)가 같은 병을 두 번 냈다 — 세 번째를 사고로 만나지 않으려고 정적 스캔으로 올린다.
 *
 * ⭐스코프 경위(오르테가군 판정, 2026-07-31 — 실측 넷을 대 보고 정한 것) — 처음엔 import를
 * 따라가는 전이적 폐쇄(「부모가 자식을 렌더하면 자식의 문구도 부모 화면의 일부」)로 시도했으나
 * depth 1만 가도 681건, 무제한이면 2172건까지 폭발했다(page.tsx 하나가 앱의 절반을 끌어옴).
 * 파일 자신의 키만 봐도(258건) 대부분이 「같은 개념을 여러 자리서 말한다」(docs.save="저장"
 * ↔ statusSaved="저장 완료" — 정상)였지 「다른 두 셈을 같은 말로 헷갈린다」(#2352·#2365의
 * 진짜 모양)가 아니었다. 그래서 축을 둘로 좁혔다:
 *   ①스코프 = «한 파일 안»만(전이적 폐쇄 없음)
 *   ②그 중에서도 «최소 한쪽이 수와 함께 서는» 쌍만(아래 isNumberAdjacent) — #2352·#2365
 *     둘 다 한쪽이 카운터였다(28·30). docs.save↔statusSaved류는 수가 안 붙어 저절로 빠진다.
 *     처음엔 "호출 자리에 2번째 인자가 있는가"·"근접(±150자)에 `value={` prop이 있는가"도
 *     같이 넣어 119건이 나왔으나, 표본을 열어 보니 form 필드가 몰린 파일(goals-client.tsx
 *     등)에서 근접 `value={`가 «전혀 무관한 옆 input»까지 우연히 잡아 노이즈였다 — 데이터
 *     근거가 약한 휴리스틱이라 뺐다. ko.json 값 자체의 `{n}`류 보간 하나만 남기니(가장 정밀한
 *     신호 — "이 문구 템플릿 자체가 수를 담는다"는 사실이지 근접 추정이 아니다) 40건으로
 *     줄었고 표본이 실제로 #2352·#2365과 같은 모양(짧은 라벨 ⊂ 카운터 달린 긴 문구)이었다.
 *
 * ⛔이 v1은 #2352·#2365 «원 사고 자체»를 재현 못한다 — 둘 다 서로 다른 파일(next-maker-
 * header.tsx ↔ flow-client.tsx)이 원인이었다. AC2(양성대조)는 «같은 파일 안»에서 같은
 * 모양(라벨+수)을 만든 합성 픽스처로 세운다 — 크로스파일은 #2744처럼 손수 테스트 영역.
 *
 * AC4 — 이 가드가 «못 잡는 것» 넷. 선언 안 하면 다음 사람이 "이게 다 본다"로 읽는다.
 *   ㉠크로스파일(다른 컴포넌트가 같은 화면에 서는 경우) — #2352·#2365 원 사고 자체가 이 모양.
 *     정적 분석으로 "같은 화면인가"를 못 재 v1 스코프 밖(위 경위 그대로).
 *   ㉡동적 키 조합 — `t(\`status_${x}\`)`처럼 키 이름이 런타임에 조립되면 정규식이 문자열
 *     리터럴을 못 뽑는다(까심 1차 표본에서 5개 소비처가 이 모양으로 실측됨).
 *   ㉢en.json 미검사 — 이번 판은 ko.json만 본다.
 *   ㉣「수와 함께」판정 자체가 근사다 — ko.json 값이 `{n}`류 보간 자리를 갖는지만 본다.
 *     next-maker-header.tsx의 실제 사고 모양(`<ZeroStageCell value={n} label={t('key')} />`
 *     — 수가 문자열 «밖»에서 형제 prop으로 서는 경우)은 이 신호로 못 잡는다(위 경위 그대로
 *     — 근접 휴리스틱은 노이즈가 더 커서 뺐다). 실제 렌더 결과를 실행해 보지도 않는다.
 *     ⭐⭐(유나양 실측, 2026-07-31) — 그래서 이 스캔은 «값 안에 수가 있는» 충돌만 본다.
 *     수가 «따로» 렌더되는 자리(수 카드 라벨류 — flow.nextMakerPendingApproval="게이트
 *     승인 대기"·glance.exceptionKindGatePending="결재 대기" 등, 넷 다 numberAdjacent=false로
 *     실측 확認)는 못 잡는다 — #2365가 정확히 그 종류였다. 즉 «이 가드를 낳은 사례 자체를
 *     이 가드가 못 잡는다». 안 적으면 다음 사람이 "이 축은 CI가 본다"로 읽고 손을 놓는다.
 *
 * AC5 — 오탐(지금은 안 겹치는데 걸리는 것)은 EXEMPT_PAIRS에 "왜"·"언제 다시 볼지"와 함께
 * 등재한다. 이유 없는 예외는 다음 사람이 못 읽는다.
 *
 * ⚠️CI 안전장치 — 이 스텝은 `ci` job(required check) 안에 있다. 이 스토리 자신은 카피를
 * 안 고치므로(AC6) 이번 첫 스캔이 잡은 40건이 그대로 남는데, 그걸 그냥 FAIL로 두면 이
 * PR도 다른 모든 PR도 영원히 막힌다 — verify-no-new-md-breakpoint.ts의 ALLOWLIST와 같은
 * 관례로 GRANDFATHER_BASELINE(아래, #2367 최초 스캔 40건)을 얼린다. «새» 충돌(baseline
 * 밖)만 FAIL — grandfather는 매 실행 로그에 그대로 찍혀 "원래 그런 것"으로 안 묻힌다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// story #2410 회귀(카디르 QA, PR #2790, 2026-08-01) — SRC_ROOT를 `process.cwd()` 기준으로
// 잡았다가 루트에서 도는 `pnpm vitest run`(CI)이 이 모듈을 import하는 순간 ENOENT로 죽었다.
// scanRepository() 추출 전엔 main()이 CLI 전용이라 cwd가 항상 apps/web이라 안 터졌던 것 —
// 같은 레포 같은 날 #2774(verify-no-orphan-resource-routes.ts)와 동일한 병. 스크립트 자기
// 위치(import.meta.url) 기준으로 고정하면 호출부의 cwd와 무관해진다.
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const MESSAGES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages', 'ko.json');
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

export interface CollisionPair {
  keyA: string;
  keyB: string;
  valueA: string;
  valueB: string;
  file: string;
}

// ── 파일이 직접 쓰는 (namespace, key) + 「수와 함께 서는가」 ─────────────────

const USE_TRANSLATIONS_RE = /\bconst\s+(\w+)\s*=\s*useTranslations(?:<[^>()]*>)?\(\s*(?:['"]([^'"]+)['"])?\s*\)/g;

/** 파일 안의 `const X = useTranslations('ns')` 바인딩을 전부 뽑는다. 네임스페이스 없이
 * 부르는 형태(`useTranslations()`)는 이 축의 대상이 아니라 건너뛴다(안전한 쪽 누락). */
export function parseTranslationBindings(content: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const m of content.matchAll(USE_TRANSLATIONS_RE)) {
    if (m[2]) bindings.set(m[1], m[2]);
  }
  return bindings;
}

/** 바인딩된 변수로 부르는 `varName('key')` 호출을 전부 (namespace.key) 집합으로 뽑는다.
 * ⛔동적 키(`varName(\`...${x}\`)`)는 문자열 리터럴이 아니라 이 정규식이 원래 못 본다
 * (AC4㉡ — countDynamicKeyCalls가 이걸 센다). */
export function parseKeyUsages(content: string, bindings: Map<string, string>): Set<string> {
  const used = new Set<string>();
  for (const [varName, namespace] of bindings) {
    const re = new RegExp(`(?<![\\w.])${varName}\\(\\s*['"]([A-Za-z0-9_.]+)['"]`, 'g');
    for (const m of content.matchAll(re)) {
      used.add(`${namespace}.${m[1]}`);
    }
  }
  return used;
}

/** AC4㉡ 카운트용 — 바인딩된 변수를 템플릿 리터럴로 부르는 자리(정적으로 못 뽑는 동적 키). */
export function countDynamicKeyCalls(content: string, bindings: Map<string, string>): number {
  let count = 0;
  for (const varName of bindings.keys()) {
    const re = new RegExp(`(?<![\\w.])${varName}\\(\\s*\`[^\`]*\\$\\{`, 'g');
    count += [...content.matchAll(re)].length;
  }
  return count;
}

// ── ko.json 평평화(중첩 네임스페이스 지원 — proofCapsule.claim.* 등) ──────────

export function flattenMessages(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const qualified = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      flat.set(qualified, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [nk, nv] of flattenMessages(v as Record<string, unknown>, qualified)) {
        flat.set(nk, nv);
      }
    }
  }
  return flat;
}

// story #2410 — 이름(isNumberAdjacent)과 «재는 것»을 맞춘다. 예전 PLACEHOLDER_VALUE_RE는
// 보간 자리가 «있기만 하면» true였다 — 그게 이름·런타임처럼 «수가 아닌» 보간까지 「수와
// 함께 선다」로 잘못 읽어 EXEMPT_PAIRS가 7건까지 쌓인 근본원인이었다(#2404: {runtime} ·
// #2406: {name}). 47개(GRANDFATHER_BASELINE 40 + EXEMPT_PAIRS 7)에 실제로 쓰이는 보간
// 이름을 전수 대조해(2026-08-02) 「절대 수가 아님을 값을 직접 읽어 확認한」 이름만 배제
// 목록에 올린다 — 나머지(미확認·모호한 것 포함)는 «안전한 쪽»(예전과 동일하게 true)으로
// 남긴다. 모르는 이름을 마음대로 false로 내리면 그게 새 오탐이 아니라 새 «누락»(놓친 진짜
// 충돌)이 되고, 이 가드는 놓치는 쪽보다 과하게 잡는 쪽이 안전하다(EXEMPT_PAIRS로 되돌릴
// 수 있지만 누락은 그 자체로 안 보인다).
//
// 배제 근거(각 이름의 실제 ko.json 값을 직접 읽고 판정, 파일 하단 커밋 참조):
//   name       — 사람/에이전트 이름("{name} 비활성화"·"{name}이(가)...")
//   runtime    — MCP 런타임 이름("{runtime} MCP 설정" — claude-code 등)
//   filename·promptFile — 파일 이름
//   gate       — 게이트 이름/사유 문자열("{gate} 대기 중")
//   role       — 역할 이름(PM/Engineer 등)
//   project    — 프로젝트 이름
//   teamId     — Slack 워크스페이스 ID(문자열 식별자, 카운트 아님)
//   dir        — 방향 기호(↑/↓), 수치 아님
//   sources·excludes — 수집 범위를 나타내는 라벨 목록
// ⛔새 이름을 여기 더하기 前에(PO 지적, 2026-08-02): 그 이름이 실제로 채우는 ko.json 값을
// 먼저 읽는다. 정말 이름·경로류(수가 아님)면 더한다. 그런데 만약 «숫자인» 값인데 여기 걸려
// EXEMPT_PAIRS에 다시 나타난다면, 그건 denylist 후보가 아니라 «진짜 충돌»이다 — 그 경우
// denylist를 늘려 조용히 덮지 말고 그 충돌 자체를 고치거나(문구 수정) EXEMPT_PAIRS에
// 이유와 함께 등재한다. 이 목록은 "수가 아님이 확認된 것"만 오는 자리이지 "오탐을 없애는
// 자리"가 아니다 — 그 둘을 섞으면 이 스토리(#2410)가 고친 바로 그 병(가드가 자기가 뭘
// 재는지 모르게 되는 것)이 재발한다.
const NON_NUMBER_PLACEHOLDER_NAMES = new Set([
  'name', 'runtime', 'filename', 'promptFile', 'gate', 'role', 'project', 'teamId', 'dir',
  'sources', 'excludes',
]);
const PLACEHOLDER_NAME_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

export function isNumberAdjacent(value: string): boolean {
  for (const m of value.matchAll(PLACEHOLDER_NAME_RE)) {
    if (!NON_NUMBER_PLACEHOLDER_NAMES.has(m[1]!)) return true;
  }
  return false;
}

// ── 충돌 판정 ────────────────────────────────────────────────────────────

/** 서로 다른 키의 값이 부분문자열 관계(포함하거나 포함되는)면서 «최소 한쪽이 수와 함께
 * 서면» 그 쌍을 낸다. docs.save↔statusSaved류(수 없음)는 저절로 빠진다.
 *
 * ⛔story #2410에서 "값이 완전히 동일하면 numberAdjacent 무관하게 항상 잡는다"는 분기를
 * 한 번 넣었다가 «되돌렸다» — 실측하니 완전동일-정적라벨 쌍(예: docs.preview="미리보기"
 * <-> docs.formatPreview="미리보기", "완료"·"저장 중..." 등)이 29건 «신규 FAIL»로 쏟아졌다.
 * 이건 이 가드가 원래부터 저절로 빼려던 그 모양(docs.save↔statusSaved류) 그 자체다 — 수와
 * 무관하게 완전동일이면 다 잡는다는 건 이 가드의 존재 이유(#2352·#2365 — «수와 함께 서는»
 * 축)를 무시한 과확장이었다. 값을 실행해 보지 않고 판단부터 넣으면 이렇게 걸린다는 걸
 * 스스로 보인 자리라 남겨 둔다. */
export function findSubstringCollisions(
  phrases: Map<string, { value: string; numberAdjacent: boolean }>,
): Array<{ keyA: string; keyB: string; valueA: string; valueB: string }> {
  const entries = [...phrases.entries()].filter(([, v]) => v.value.trim().length > 0);
  const collisions: Array<{ keyA: string; keyB: string; valueA: string; valueB: string }> = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [keyA, a] = entries[i];
      const [keyB, b] = entries[j];
      if (!a.numberAdjacent && !b.numberAdjacent) continue;
      if (a.value.includes(b.value) || b.value.includes(a.value)) {
        collisions.push({ keyA, keyB, valueA: a.value, valueB: b.value });
      }
    }
  }
  return collisions;
}

// AC5 — 지금은 실제로 안 겹치지만 이 스캔이 걸릴 수 있는 자리. 항목마다 이유+재검토 시점.
// «영구 정상»으로 코드로 확認된 것만 여기 온다 — GRANDFATHER_BASELINE(아래, 미triage 채무)과
// 다르다.
//
// ✅story #2410(2026-08-02)에서 아래 일곱을 «재평가»해 전부 걷어냈다 — 예전엔 여기 있었다:
//   recruiter.{equipDone,next,stepComplete,stepVerify} <-> recruiter.verifyGuideMcp (#2404, {runtime})
//   settings.{deactivateAgent,activateAgent,deactivateAgentDialogConfirm} <-> settings.deactivateAgentDialogTitle (#2406, {name})
// 근본원인(isNumberAdjacent가 이름·런타임 보간까지 "수와 함께 선다"로 오판)을 고치니 이
// 일곱 전부 이 스캔에서 «다시 안 걸린다»(재현 확認 — tsx로 실행해 exemptHit 0/7, 신규
// FAIL도 0건인 것까지 봤다). 즉 «지금 정말 안전한데 가드가 몰라서 면제해 둔» 상태에서
// «가드가 스스로 안 겹친다는 걸 아는» 상태로 옮겨졌다 — EXEMPT_PAIRS는 이제 빈 목록이 맞고,
// 앞으로 이름·런타임류 보간이 다시 오탐으로 걸리면 그건 NON_NUMBER_PLACEHOLDER_NAMES에
// 새 이름을 더할 자리이지 여기 되돌아올 자리가 아니다.
//
// story #2792(2026-08-02) — `recruiter.verifyGuideMcpStdio`(verifyGuideMcp의 stdio 전용
// 짝)도 같은 `{runtime}` 보간을 쓴다. rebase 前(#2410/#2790 이전 기준 worktree)에는 이
// denylist가 없어 신규 짝 4개를 여기 추가했었으나, rebase 뒤 재스캔(신규 0건·exempt 0건)으로
// «필요 없음»이 실측 확認돼 다시 뺐다 — NON_NUMBER_PLACEHOLDER_NAMES의 `runtime`이 이미
// 덮는다(PO 지적: rebase 안 하면 #2790이 오늘 한 일이 부분적으로 되돌아간다).
//
// story #2413(2026-08-02, PO 승인) — sprints.days <-> sprints.overdueBadge.
// ①왜 안전한가 — sprints.days는 값이 "일"(한 글자 단위 접미사, 보간조차 없다)이라
// «어떤 N일 문구에도» 부분문자열로 걸린다. #2352/#2365가 잡으려는 "두 셈이 헷갈리는" 병이
// 아니라 «키 값이 너무 짧아» 생기는 것이다 — {days}(overdueBadge의 실제 보간)가 숫자라서
// 면제하는 게 아니다(숫자면 오히려 #2410 규칙상 "진짜 충돌"로 읽혀야 한다). 충돌의 원인은
// {days}가 아니라 짧은 단위-접미사 키 자체다 — 이 구별이 안 되면 #2410 후속에서 엉뚱한
// 곳(보간 이름 쪽)을 고치게 된다.
// ②언제 걷는가 — 가드가 "한 글자·단위 접미사 값의 키"를 부분문자열 검사 대상에서 빼면
// 이 면제는 불필요해진다. #2410과는 다른 축(보간 이름이 아니라 키 길이)이라 별도 후속
// 후보로 남긴다.
// rebase 재확認(2026-08-02, PO 요청) — origin/develop 최신(#2790/#2792/#2793/#2794 반영)
// 기준으로 재스캔해도 이 항목은 여전히 필요하다(아래 게이트 로그로 확認) — #2792의 임시
// 항목과 달리 이건 #2410의 근본 fix로 해소되는 축이 아니라서 그대로 남는다.
// story #2485(2026-08-06) — settings.tabProjects/roleMember <-> onboarding/settings의
// PLAN_LIMIT_EXCEEDED 안내문 2쌍. sprints.days와 같은 축(길이 짧은 일반명사 키가 긴
// 문장에 우연히 포함) — #2352/#2365가 잡으려는 "같은 화면에 선 두 «수»가 헷갈리는" 병이
// 아니다: tabProjects/roleMember 양쪽 다 그 자체엔 수가 없다(단순 라벨). 겹치는 건 오직
// "프로젝트"/"멤버"라는 공통 명사 부분이지, 두 카운트가 시각적으로 혼동되는 상황이 아니다.
export const EXEMPT_PAIRS = new Set<string>([
  'sprints.days <-> sprints.overdueBadge',
  'onboarding.projectLimitExceededError <-> settings.tabProjects',
  'settings.memberLimitExceededError <-> settings.roleMember',
]);

// ⛔⭐오르테가군 지적(2026-07-31) — 이 목록에 «새로» 넣는 것은 PO 승인을 거친다. 이유 없이
// 넣지 않는다. 이 길을 그냥 열어 두면 "새 충돌이 FAIL 났을 때 담당이 baseline에 넣고 지나가는"
// 것이 가능해지고, 그건 오늘 하루 종일 잡은 「가드에 걸리면 답이 셋(고친다·정말 안전을
// 증명한다·가드를 줄인다) 중 가드를 줄이는 쪽」이 된다. 41번째 항목부터는 PR 설명에 «왜»와
// «언제 재검토하는지»를 반드시 남기고, design:pass/qa:pass 리뷰가 그 승인 자리다 — 조용히
// 추가된 것이 없는지는 이 파일의 diff 자체가 리뷰 대상이 된다는 뜻이다.
//
// 아래 40건은 #2367 «최초 스캔»의 스냅샷이라 이 규율의 예외다(2026-07-31 실측, AC7 —
// 이 수는 story #2367에도 판단으로 남겨 코드 diff만으로 사라지지 않게 한다. GRANDFATHER_
// BASELINE_COUNT_TEST가 크기 40을 고정해 조용한 증감을 리뷰 없이 못 지나가게 막는다).
// verify-no-new-md-breakpoint.ts의 ALLOWLIST와 같은 관례: 새로 등장하는 충돌만 막고 기존
// 채무는 개별 triage(다음 스토리)로 넘긴다. ⛔이 목록에 넣는 것 자체가 "이 스토리는 카피를
// 고치는 일이 아니다"(AC6)를 지키는
// 방법이다 — 여기 있는 40건 «중 실제로 몇 건이 진짜 결함인지»는 이 스토리가 판정하지 않는다.
// 그래도 매 실행 로그에 grandfather 카운트로 찍혀 "원래 그런 것"으로 조용히 묻히지 않는다.
// story #2410(PO 지적, 2026-08-02): 이 40건 중 18건은 이제 이 스캔에 «안 걸린다» — isNumberAdjacent
// 정밀화(이름·런타임류 배제) 여파로, 그동안 「진짜 결함인지 몰랐던」게 아니라 「애초에 numberAdjacent가
// 아니었던」 것으로 밝혀졌다. Set 크기(40)는 #2367 최초 스캔 스냅샷이라 그대로 두지만("아래 40건" 문단
// 그대로), 매 실행 로그의 "안 걸림" 경고만으로는 다음 사람이 노이즈로 읽고 넘길 수 있어 여기 명시로
// 남긴다 — 실 걸림 수(22)는 GRANDFATHER_LIVE_COUNT_TEST가 고정한다(아래).
// 안 걸리는 18건: board.backlinksEmptyFallback<->board.backlinksEmptyScoped · canvas.resolveAction<->
// canvas.resolvedByNote · dashboard.ccAgentStuck<->dashboard.ccWaitingGateReason ·
// recruiter.back<->recruiter.{guideFileDeliveryNoteConnector,guideFileDeliveryNoteMcp,kitOrientingGuideBody} ·
// recruiter.equipCreatedTitle<->recruiter.{equipDone,stepComplete} ·
// recruiter.equipDone<->recruiter.{guideFileDeliveryNoteConnector,kitOrientingTitle} ·
// recruiter.guideFileDeliveryNoteConnector<->recruiter.{kitOrientingGuideBody,stepComplete} ·
// recruiter.kitOrientingTitle<->recruiter.stepComplete · settings.projectCreated<->settings.tabProjects ·
// settings.slackIntegration.{mappedElsewhereHint,pendingHint}<->settings.slackIntegration.saveLabel ·
// settings.slackIntegration.workspaceConnectedSummary<->settings.slackIntegration.workspaceLabel ·
// standup.feedback<->standup.feedbackDialogTitle
// ⇒ 이 18건을 GRANDFATHER_BASELINE에서 걷어낼지(진짜 결함이 아니었다고 결론)는 이 PR이 정하지 않는다
// (AC6과 같은 판단 — 이 스토리는 정밀화만, triage는 별도).
export const GRANDFATHER_BASELINE = new Set<string>([
  'board.backlinksEmptyFallback <-> board.backlinksEmptyScoped',
  'cage.pendingSummary <-> cage.trustScorePending',
  'canvas.resolveAction <-> canvas.resolvedByNote',
  'chats.agent <-> chats.agentCount',
  'chats.agentCount <-> chats.agentSection',
  'chats.agentCount <-> chats.personCount',
  'chats.agentCount <-> chats.you',
  'chats.participantsOthers <-> chats.personCount',
  'dashboard.ccAgentStuck <-> dashboard.ccWaitingGateReason',
  'dashboard.ccQueueTruncated <-> dashboard.ccWaitingTitle',
  'docs.searchResultCount <-> docs.title',
  'goals.fieldPriority <-> goals.steerCappedNote',
  'goals.spExceeded <-> goals.spExceededDetail',
  'goals.spExceededDetail <-> goals.title',
  'goals.steerCappedNote <-> goals.steerCurated',
  'hypotheses.target <-> retro.hTargetLine',
  'inbox.bellAriaLabelCount <-> inbox.panelTitle',
  'presence.fabLabelWorking <-> presence.panelTitle',
  'recruiter.back <-> recruiter.guideFileDeliveryNoteConnector',
  'recruiter.back <-> recruiter.guideFileDeliveryNoteMcp',
  'recruiter.back <-> recruiter.kitOrientingGuideBody',
  'recruiter.equipCreatedTitle <-> recruiter.equipDone',
  'recruiter.equipCreatedTitle <-> recruiter.stepComplete',
  'recruiter.equipDone <-> recruiter.guideFileDeliveryNoteConnector',
  'recruiter.equipDone <-> recruiter.kitOrientingTitle',
  'recruiter.guideFileDeliveryNoteConnector <-> recruiter.kitOrientingGuideBody',
  'recruiter.guideFileDeliveryNoteConnector <-> recruiter.stepComplete',
  'recruiter.kitOrientingTitle <-> recruiter.stepComplete',
  'retro.recConfMid <-> retro.tallyMeasuring',
  'settings.projectCreated <-> settings.tabProjects',
  'settings.slackIntegration.mappedElsewhereHint <-> settings.slackIntegration.saveLabel',
  'settings.slackIntegration.pendingHint <-> settings.slackIntegration.saveLabel',
  'settings.slackIntegration.saveLabel <-> settings.slackIntegration.savePending',
  'settings.slackIntegration.savePending <-> settings.slackIntegration.saveRow',
  'settings.slackIntegration.workspaceConnectedSummary <-> settings.slackIntegration.workspaceLabel',
  'standup.blockersRollupTitle <-> standup.today',
  'standup.feedback <-> standup.feedbackDialogTitle',
  'storage.capacityUpgrade <-> storage.capacityWarnDesc',
  'storage.delete <-> storage.deleteImpact',
  'verify.chatProofCount <-> verify.chatProofSectionTitle',
]);

export function pairKey(keyA: string, keyB: string): string {
  return [keyA, keyB].sort().join(' <-> ');
}

// ── 파일 순회 ────────────────────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export interface RepositoryScanResult {
  files: string[];
  totalDynamicCalls: number;
  newFindings: Map<string, CollisionPair>;
  grandfathered: Map<string, CollisionPair>;
  exemptHit: Set<string>;
  grandfatherHit: Set<string>;
}

/** main()에서 뽑아낸 전 저장소 스캔 — story #2410, GRANDFATHER_LIVE_COUNT_TEST가 이걸 불러
 * "지금 실제로 걸리는 grandfather 수"를 고정한다(console.log 경고만으로는 다음 사람이
 * 노이즈로 읽고 넘기는 것을 막는다, PO 지적). */
export function scanRepository(): RepositoryScanResult {
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const messages = flattenMessages(JSON.parse(readFileSync(MESSAGES_PATH, 'utf8')));

  let totalDynamicCalls = 0;
  const newFindings = new Map<string, CollisionPair>();
  const grandfathered = new Map<string, CollisionPair>();
  const exemptHit = new Set<string>();
  const grandfatherHit = new Set<string>();

  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const bindings = parseTranslationBindings(content);
    if (bindings.size === 0) continue;
    const usages = parseKeyUsages(content, bindings);
    totalDynamicCalls += countDynamicKeyCalls(content, bindings);

    const phrases = new Map<string, { value: string; numberAdjacent: boolean }>();
    for (const qualifiedKey of usages) {
      const value = messages.get(qualifiedKey);
      if (value === undefined) continue;
      phrases.set(qualifiedKey, { value, numberAdjacent: isNumberAdjacent(value) });
    }

    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    for (const c of findSubstringCollisions(phrases)) {
      const pk = pairKey(c.keyA, c.keyB);
      const pair: CollisionPair = { keyA: c.keyA, keyB: c.keyB, valueA: c.valueA, valueB: c.valueB, file: rel };
      if (EXEMPT_PAIRS.has(pk)) {
        exemptHit.add(pk);
      } else if (GRANDFATHER_BASELINE.has(pk)) {
        grandfatherHit.add(pk);
        if (!grandfathered.has(pk)) grandfathered.set(pk, pair);
      } else if (!newFindings.has(pk)) {
        newFindings.set(pk, pair);
      }
    }
  }

  return { files, totalDynamicCalls, newFindings, grandfathered, exemptHit, grandfatherHit };
}

function main(): void {
  const { files, totalDynamicCalls, newFindings, grandfathered, exemptHit, grandfatherHit } = scanRepository();

  const staleExempt = [...EXEMPT_PAIRS].filter((pk) => !exemptHit.has(pk));
  const staleGrandfather = [...GRANDFATHER_BASELINE].filter((pk) => !grandfatherHit.has(pk));

  console.log(
    `[AC7] i18n 문구 충돌 스캔(같은 파일·수와 함께 서는 쌍만) — 파일 ${files.length}개 · ` +
      `동적 키 호출(정적 미포착) ${totalDynamicCalls}건(AC4㉡) · grandfather(미triage 채무, 안 막음) ${grandfatherHit.size}건 · ` +
      `exempt ${EXEMPT_PAIRS.size}건 · en.json 미검사(AC4㉢)`,
  );
  if (staleExempt.length > 0) {
    console.log(`  ⚠️ exempt로 등재됐으나 이번 스캔에서 안 걸린(죽은 문서 후보): ${staleExempt.join(', ')}`);
  }
  if (staleGrandfather.length > 0) {
    console.log(`  ⚠️ grandfather로 등재됐으나 이번 스캔에서 안 걸린(고쳐졌다면 목록에서 빼도 되는): ${staleGrandfather.join(', ')}`);
  }
  if (grandfathered.size > 0) {
    console.log(`\n📋 grandfather(#2367 최초 스캔 40건 — AC6: 이 스토리는 안 고친다, 목록만 낸다):`);
    for (const c of [...grandfathered.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  - [${c.file}] ${c.keyA}="${c.valueA}" <-> ${c.keyB}="${c.valueB}"`);
    }
  }

  if (newFindings.size > 0) {
    console.log(`\n❌ FAIL: 새 부분문자열 충돌 ${newFindings.size}건(grandfather 밖 — 신규):`);
    for (const c of [...newFindings.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  - [${c.file}] ${c.keyA}="${c.valueA}" <-> ${c.keyB}="${c.valueB}"`);
    }
    console.log(
      '\n→ 「같은 파일이 렌더하는, 수와 함께 서는 두 문구가 부분문자열로 겹친다」 — #2352·#2365와 같은 클래스.' +
        ' 정말 안 겹치는 게 맞으면 EXEMPT_PAIRS에, 지금은 못 고치지만 알고 있는 채무면 GRANDFATHER_BASELINE에 이유와 함께 등재.',
    );
    process.exit(1);
  }

  console.log(`OK: 새 부분문자열 충돌 0건(grandfather ${grandfathered.size}건은 위 목록대로 남아있음 — 신규만 막는다)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
