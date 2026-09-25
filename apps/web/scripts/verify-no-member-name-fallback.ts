/**
 * story #4286 회귀가드 — 구성원 이름 칸 폴백 래칫. 3755 · 3758번 표시명 스윕이 `.email` grep이라 못 잡은 모양 셋을 잡는다.
 * 선생님 상수 «이메일은 이름 칸에 안 싣는다» · 3755번 AC1 «이름 없으면 None · id 문자열 0»:
 *   ① email-prefix : `email?.split('@')` — 이메일 앞부분을 이름으로 지어냄
 *   ② id-fragment  : 구성원 id 조각(길이 무관)이나 id 통째를 이름 자리에 — `memberNames[id] ?? id.slice(0, 8)` ·
 *                    `…_member_id?.slice(0, 8)` · `?.name ?? \`#${id.slice(0, 6)}\`` · `resolveName = (id) => id` · `?.label ?? approverId`
 *   ③ question-mark: `?? '?'` · `|| '?'` — 날것 «?»를 이름(또는 문장 안 이름)으로
 * 처방은 `lib/member-display.ts`의 memberDisplayLabel(이름 빔 → «이름 없는 구성원») · memberLookupLabel(id→이름 표 ·
 * 불러오는 중 → 빈 칸 · 표에 없음 → «알 수 없는 구성원»).
 *
 * baseline-freeze(verify-no-fetch-response-without-ok-check.ts와 같은 관례): 지금 남은 자리는 이유와 함께 얼리고
 * (member-name-fallback-baseline.json), 기준표 밖의 새 자리는 FAIL. 기준표에 있는데 소스에서 사라진 자리도 FAIL
 * («낡음 = 목록 내리기» — 래칫은 내려가기만 한다). 예: PR 4638(4285번)이 trust-utils 두 자리를 걷으면 그 PR이 두 줄을 지운다.
 *
 * 못 잡는 것(선언): 이름 칸이 아닌 id 조각(작업 항목 `#id` · 실행/이벤트/메모/문서 id · 조직/프로젝트 id)은 일부러 뺐다 —
 * ②는 «구성원 id처럼 생긴 변수 이름» · «이름 표 조회 뒤 폴백» 모양만 본다. 변수 이름을 바꿔 우회하면 못 잡는다.
 * 테스트 파일(*.test.*)은 보지 않는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');
const BASELINE_PATH = path.resolve(HERE, 'member-name-fallback-baseline.json');
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.(tsx?|jsx?)$/;

export type FallbackKind = 'email-prefix' | 'id-fragment' | 'question-mark';

// 구성원 id처럼 생긴 변수 · 필드 이름(사람 · 에이전트를 가리키는 id). 작업 항목 · 문서 · 조직 id는 넣지 않는다.
const MEMBER_ID_NAME = String.raw`(?:user_id|userId|member_id|memberId|[A-Za-z]+_member_id|[a-z]+MemberId|author_id|authorId|approver_id|approverId|resolver_id|resolverId|requester_id|requesterId|verified_by|human_verified_by|humanVerifiedBy|owner_id|ownerId|published_by|actor_id|actorId)`;
const SLICE = String.raw`!?\??\.slice\(\s*0\s*,\s*\d+\s*\)`;

const PATTERNS: { kind: FallbackKind; re: RegExp }[] = [
  { kind: 'email-prefix', re: /\bemail\s*[!?]?\??\.split\(\s*['"`]@['"`]\s*\)/ },
  // 구성원 id 변수를 자름 — `m.user_id?.slice(0, 8)` · `story.human_verified_by.slice(0, 6)` · `approverId.slice(0, 8)`
  { kind: 'id-fragment', re: new RegExp(String.raw`\b${MEMBER_ID_NAME}${SLICE}`) },
  // 이름 표 조회 뒤 폴백으로 아무 id나 자름 — `memberNames[x] ?? id.slice(0, 6)` · `?.name ?? \`#${id.slice(0, 8)}\``
  { kind: 'id-fragment', re: new RegExp(String.raw`(?:\b(?:memberNames|memberMap|memberNameById|names)\[[^\]]+\]|\?\.name)[^;\n]*?(?:\?\?|\|\|)[^;\n]*?\b\w*[iI]d${SLICE}`) },
  // 이름을 못 찾으면 id 통째 — `?.name ?? memberId` · `?.label ?? approverId`
  // (프로젝트 · 조직 id는 구성원이 아니라 뺀다 — 오른쪽이 구성원 id처럼 생긴 이름일 때만)
  { kind: 'id-fragment', re: new RegExp(String.raw`\?\.(?:name|label)\s*\?\?\s*(?:[A-Za-z_]+\.)*${MEMBER_ID_NAME}\b(?!\s*[.(\[])`) },
  // resolveName 기본값이 id를 그대로 돌림 — `resolveName = (id) => id`
  { kind: 'id-fragment', re: /\bresolveName\s*=\s*\(\s*(\w+)\s*\)\s*=>\s*\1\b\s*[,)]/ },
  { kind: 'question-mark', re: /(?:\?\?|\|\|)\s*['"`]\?['"`]/ },
];

export interface FallbackHit {
  file: string;
  line: number;
  kind: FallbackKind;
  snippet: string;
  key: string;
}

function normalize(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

// memberNameById(map, id, t, unknownFallback)의 넷째 인자가 구성원 id(통째)나 id 조각이면 «목록에 없음»에 id를 싣는 것(4646 뼈대 ·
// stuck-handoff · story-detail 옛 값). 인자 안에 괄호가 있어 정규식 대신 괄호 깊이로 최상위 쉼표를 가른다.
function memberNameByIdIdFallback(line: string): boolean {
  let at = line.indexOf('memberNameById(');
  while (at !== -1) {
    let depth = 0; let start = at + 'memberNameById('.length; const args: string[] = []; let cur = '';
    for (let i = start; i < line.length; i += 1) {
      const ch = line[i]!;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { args.push(cur); break; } depth -= 1; }
      if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
      cur += ch;
    }
    const fb = (args[3] ?? '').trim();
    if (fb && (new RegExp(String.raw`\.slice\(\s*0\s*,`).test(fb) || new RegExp(String.raw`^(?:[A-Za-z_]+\.)*(?:${MEMBER_ID_NAME}|id|[a-z_]*_by|created_by|resolved_by)$`).test(fb))) return true;
    start = at + 1;
    at = line.indexOf('memberNameById(', start);
  }
  return false;
}

export function findMemberNameFallbacks(content: string, file: string): FallbackHit[] {
  const hits: FallbackHit[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*')) continue;
    const seen = new Set<FallbackKind>();
    if (memberNameByIdIdFallback(line)) {
      seen.add('id-fragment');
      const snippet = normalize(line);
      hits.push({ file, line: i + 1, kind: 'id-fragment', snippet, key: `${file}::id-fragment::${snippet}` });
    }
    for (const { kind, re } of PATTERNS) {
      if (seen.has(kind)) continue;
      if (re.test(line)) {
        seen.add(kind);
        const snippet = normalize(line);
        hits.push({ file, line: i + 1, kind, snippet, key: `${file}::${kind}::${snippet}` });
      }
    }
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepository(root: string = SRC_ROOT): FallbackHit[] {
  const files: string[] = [];
  walk(root, files);
  const hits: FallbackHit[] = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    hits.push(...findMemberNameFallbacks(readFileSync(abs, 'utf8'), rel));
  }
  return hits;
}

export interface BaselineEntry {
  key: string;
  reason: string;
}

export function loadBaseline(p: string = BASELINE_PATH): BaselineEntry[] {
  return JSON.parse(readFileSync(p, 'utf8')) as BaselineEntry[];
}

export function compareWithBaseline(hits: FallbackHit[], baseline: BaselineEntry[]): { fresh: FallbackHit[]; stale: BaselineEntry[] } {
  const keys = new Set(baseline.map((b) => b.key));
  const found = new Set(hits.map((h) => h.key));
  return {
    fresh: hits.filter((h) => !keys.has(h.key)),
    stale: baseline.filter((b) => !found.has(b.key)),
  };
}

// 양성 대조 — 가드가 옛 모양을 실제로 잡는지 스스로 확인(각 모양 하나라도 놓치면 FAIL).
export const SELF_TEST_SAMPLES: { kind: FallbackKind; code: string }[] = [
  { kind: 'email-prefix', code: "name: (m.name?.trim() || null) ?? m.email?.split('@')[0]," },
  { kind: 'id-fragment', code: "name: m.name ?? m.user_id?.slice(0, 8)," },
  { kind: 'id-fragment', code: 'const n = memberNames[gate.resolver_id] ?? gate.resolver_id.slice(0, 8);' },
  { kind: 'id-fragment', code: 'resolveName={(id) => memberNames[id] ?? id.slice(0, 6)}' },
  { kind: 'id-fragment', code: 'return members.find((m) => m.id === id)?.name ?? `#${id.slice(0, 8)}`;' },
  { kind: 'id-fragment', code: '<span>@{hypothesis.owner_member_id?.slice(0, 8) ?? t(\'owner\')}</span>' },
  { kind: 'id-fragment', code: "? (approverOptions.find((o) => o.value === approverId)?.label ?? approverId)" },
  { kind: 'id-fragment', code: "export function Badge({ resolveName = (id) => id, compact }: Props) {" },
  { kind: 'question-mark', code: "name: unconnectedAgentParticipants[0]!.name ?? '?'," },
  { kind: 'id-fragment', code: 'resolveName={(id) => memberNameById(memberMap, id, tc, id.slice(0, 6))}' },
  { kind: 'id-fragment', code: 'author: memberNameById(memberMap, c.created_by, tc, c.created_by),' },
];

export function runSelfTest(): string[] {
  const misses: string[] = [];
  for (const s of SELF_TEST_SAMPLES) {
    if (!findMemberNameFallbacks(s.code, 'self-test.tsx').some((h) => h.kind === s.kind)) misses.push(`${s.kind}: ${s.code}`);
  }
  return misses;
}

function main(): void {
  const misses = runSelfTest();
  if (misses.length > 0) {
    console.log('\nFAIL: 가드 자체 점검(양성 대조) — 옛 모양을 못 잡음:');
    for (const m of misses) console.log(`  - ${m}`);
    process.exit(1);
  }
  const hits = scanRepository();
  const baseline = loadBaseline();
  const { fresh, stale } = compareWithBaseline(hits, baseline);
  if (fresh.length > 0 || stale.length > 0) {
    if (fresh.length > 0) {
      console.log(`\nFAIL: 기준표 밖 구성원 이름 칸 폴백 ${fresh.length}건 — memberDisplayLabel / memberLookupLabel(lib/member-display.ts)로:`);
      for (const h of fresh) console.log(`  - [${h.kind}] ${h.file}:${h.line} ${h.snippet}`);
    }
    if (stale.length > 0) {
      console.log(`\nFAIL: 기준표에 있는데 소스에서 사라진 자리 ${stale.length}건 — scripts/member-name-fallback-baseline.json에서 지울 것(래칫 내리기):`);
      for (const b of stale) console.log(`  - ${b.key}`);
    }
    process.exit(1);
  }
  console.log(`OK: 구성원 이름 칸 폴백 — 기준표(얼린 자리) ${baseline.length}건 그대로 · 새 자리 0 · 자체 점검 ${SELF_TEST_SAMPLES.length}/${SELF_TEST_SAMPLES.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
