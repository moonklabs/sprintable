/**
 * story #4286 회귀가드 — 구성원 이름 칸 폴백 래칫. 3755 · 3758번 표시명 스윕이 `.email` grep이라 못 잡은 모양 셋을 잡는다.
 * 선생님 상수 «이메일은 이름 칸에 안 싣는다» · 3755번 AC1 «이름 없으면 None · id 문자열 0»:
 *   ① email-prefix : `email?.split('@')` — 이메일 앞부분을 이름으로 지어냄
 *   ② id-fragment  : 구성원 id 조각(길이 무관)이나 id 통째를 이름 자리에 — `memberNames[id] ?? id.slice(0, 8)` ·
 *                    `…_member_id?.slice(0, 8)` · `?.name ?? \`#${id.slice(0, 6)}\`` · `resolveName = (id) => id` · `?.label ?? approverId`
 *   ③ question-mark: `?? '?'` · `|| '?'` — 날것 «?»를 이름(또는 문장 안 이름)으로
 *   ④ dash-fallback : 이름 표 조회 뒤 `?? '—'` · `'-'` · `''` — 아는 사람(표에 있는데 이름 빔)도 모르는 사람도 같은 «—»(까디르 4651 P1)
 *   ⑤ email-whole   : 이름 식이 이메일 통째로 떨어짐 — `name || full_name || user.email`(① 앞부분과 같은 상수 위반)
 * 여러 줄로 나뉜 폴백(`?? …`/`|| …`가 다음 줄에서 시작)은 한 논리 줄로 합쳐 본다(까디르 4651 P1). 줄 번호는 첫 줄.
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

export type FallbackKind = 'email-prefix' | 'id-fragment' | 'question-mark' | 'dash-fallback' | 'email-whole';

// 구성원 id처럼 생긴 변수 · 필드 이름(사람 · 에이전트를 가리키는 id). 작업 항목 · 문서 · 조직 id는 넣지 않는다.
// [까디르 4651 P1] 작성 · 처리 · 담당 · 발신 id(created_by 등)도 구성원 id다 — 빠져 있어 `?.name ?? c.created_by`를 못 잡았다.
const MEMBER_ID_NAME = String.raw`(?:user_id|userId|member_id|memberId|[A-Za-z]+_member_id|[a-z]+MemberId|author_id|authorId|approver_id|approverId|resolver_id|resolverId|requester_id|requesterId|verified_by|human_verified_by|humanVerifiedBy|owner_id|ownerId|published_by|actor_id|actorId|created_by|createdBy|updated_by|updatedBy|resolved_by|resolvedBy|assignee_id|assigneeId|sender_id|senderId)`;
// 이름 표 조회 — `memberMap[id]` · `memberNames[id]` · `memberById.get(id)`(뒤에 `?.name` 선택)
const NAME_TABLE_LOOKUP = String.raw`\b(?:memberNames|memberMap|memberNameById|nameById|names|memberById)(?:\[[^\]]+\]|\.get\([^)]*\))(?:\?\.name)?`;
const SLICE = String.raw`!?\??\.slice\(\s*0\s*,\s*\d+\s*\)`;

const PATTERNS: { kind: FallbackKind; re: RegExp }[] = [
  { kind: 'email-prefix', re: /\bemail\s*[!?]?\??\.split\(\s*['"`]@['"`]\s*\)/ },
  // 구성원 id 변수를 자름 — `m.user_id?.slice(0, 8)` · `story.human_verified_by.slice(0, 6)` · `approverId.slice(0, 8)`
  { kind: 'id-fragment', re: new RegExp(String.raw`\b${MEMBER_ID_NAME}${SLICE}`) },
  // 이름 표 조회 뒤 폴백으로 아무 id나 자름 — `memberNames[x] ?? id.slice(0, 6)` · `?.name ?? \`#${id.slice(0, 8)}\``
  { kind: 'id-fragment', re: new RegExp(String.raw`(?:\b(?:memberNames|memberMap|memberNameById|names)\[[^\]]+\]|\?\.name)[^;\n]*?(?:\?\?|\|\|)[^;\n]*?\b\w*[iI]d${SLICE}`) },
  // 이름을 못 찾으면 id 통째 — `?.name ?? memberId` · `?.label ?? approverId`
  // (프로젝트 · 조직 id는 구성원이 아니라 뺀다 — 오른쪽이 구성원 id처럼 생긴 이름이거나 한정자 없는 맨 `id`일 때만 · `doc.id`는 아님)
  // [SID:4286 · 까디르 873bcf080] `|| id`(`?.name?.trim() || reply.created_by`) · 맨 `id`(`j.data?.name ?? id`)도 — `??`만 보던 구멍.
  { kind: 'id-fragment', re: new RegExp(String.raw`\?\.(?:name|label)(?:\??\.trim\(\))?\s*(?:\?\?|\|\|)\s*(?:(?:[A-Za-z_]+\.)*${MEMBER_ID_NAME}|id)\b(?!\s*[.(\[])`) },
  // [SID:4286 · 까디르 873bcf080] 이름 표를 인덱스로 조회한 값 자체 뒤 id 통째 — `nameById[row.blocked_member_id] ?? row.blocked_member_id`
  // (표 값이 이름 문자열이라 `?.name`이 없는 모양 · 위 패턴이 못 봤다)
  { kind: 'id-fragment', re: new RegExp(String.raw`\b(?:memberNames|memberMap|memberNameById|nameById|names|memberById)(?:\[[^\]]+\]|\.get\([^)]*\))\s*(?:\?\?|\|\|)\s*(?:(?:[A-Za-z_]+\.)*${MEMBER_ID_NAME}|id)\b(?!\s*[.(\[])`) },
  // [SID:4286] 이름 · 라벨 변수 뒤 구성원 id 통째 — `targetMemberLabel ?? targetMemberId`
  { kind: 'id-fragment', re: new RegExp(String.raw`\b[a-z]\w*(?:Name|Label)\s*(?:\?\?|\|\|)\s*(?:[A-Za-z_]+\.)*${MEMBER_ID_NAME}\b(?!\s*[.(\[])`) },
  // resolveName 기본값이 id를 그대로 돌림 — `resolveName = (id) => id`
  { kind: 'id-fragment', re: /\bresolveName\s*=\s*\(\s*(\w+)\s*\)\s*=>\s*\1\b\s*[,)]/ },
  { kind: 'question-mark', re: /(?:\?\?|\|\|)\s*['"`]\?['"`]/ },
  // 이름 표 조회 뒤 일반 폴백 — `memberMap[id]?.name ?? '—'` · `?? ''` · `|| '-'`(까디르 4651 P1)
  { kind: 'dash-fallback', re: new RegExp(String.raw`${NAME_TABLE_LOOKUP}\s*(?:\?\?|\|\|)\s*['"\x60](?:—|-|–|)['"\x60]`) },
  // 이름 식이 이메일 통째로 — `name || full_name || user.email` · `m.name ?? m.email`. 값을 만드는 자리(`=` · `:` · `return` 뒤)만 본다 —
  // `if (name || m.email)` 같은 «있는지» 조건은 이름을 만들지 않는다(4638 trust-utils:138 헛잡힘으로 좁힘).
  { kind: 'email-whole', re: /(?:[:=]|\breturn\b)\s*[^;]*?\b(?:name|full_name|display_name|displayName)\b[^;]*?(?:\?\?|\|\|)\s*(?:[A-Za-z_]+\??\.)*email\b(?!\s*[.(\[?])/ },
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

// 여러 줄로 나뉜 폴백을 한 논리 줄로 — 다음 줄이 `??` · `||`로 시작하거나 이 줄이 그것으로 끝나면 이어 붙인다. 시작 줄 번호를 남긴다.
function logicalLines(content: string): { line: string; at: number }[] {
  const raw = content.split('\n');
  const out: { line: string; at: number }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i]!;
    const at = i;
    while (i + 1 < raw.length && (/^\s*(?:\?\?|\|\|)/.test(raw[i + 1]!) || /(?:\?\?|\|\|)\s*$/.test(line))) {
      i += 1;
      line = `${line} ${raw[i]!.trim()}`;
    }
    out.push({ line, at });
  }
  return out;
}

export function findMemberNameFallbacks(content: string, file: string): FallbackHit[] {
  const hits: FallbackHit[] = [];
  for (const { line, at } of logicalLines(content)) {
    const i = at;
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
  // [까디르 4651 P1] 실제 코드 모양 그대로(story-detail-panel · canvas · memo · auth-helpers에 있던 줄)
  { kind: 'id-fragment', code: 'author: memberMap[c.created_by]?.name ?? c.created_by,' },
  { kind: 'id-fragment', code: 'const authorName = memberById.get(reply.created_by)?.name ?? reply.created_by;' },
  { kind: 'dash-fallback', code: "const memberName = (id: string | null) => (id ? (memberMap[id]?.name ?? '—') : '—');" },
  { kind: 'dash-fallback', code: "<strong className=\"text-foreground\">{memberMap[c.author_id]?.name ?? '—'}</strong>" },
  { kind: 'dash-fallback', code: "? localAssigneeIds.map((id) => memberMap[id]?.name ?? '—').join(', ')" },
  { kind: 'email-whole', code: "const name = user.user_metadata?.name\n    || user.user_metadata?.full_name\n    || user.email\n    || tc('unknown');" },
  { kind: 'id-fragment', code: 'const n = memberMap[id]?.name\n  ?? id.slice(0, 8);' },
  // [SID:4286 · 까디르 873bcf080] 인덱스 접근 · `|| id` · 맨 `id` · 라벨 변수(실제 코드 모양 그대로)
  { kind: 'id-fragment', code: '{nameById[row.blocked_member_id] ?? row.blocked_member_id}' },
  { kind: 'id-fragment', code: 'return [id, j.data?.name ?? id] as const;' },
  { kind: 'id-fragment', code: 'const authorName = memberById.get(reply.created_by)?.name?.trim() || reply.created_by;' },
  { kind: 'id-fragment', code: "{t('deliveryContractEditingOnBehalfOf', { name: targetMemberLabel ?? targetMemberId })}" },
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
