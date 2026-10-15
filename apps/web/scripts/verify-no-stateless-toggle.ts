/**
 * story #4379 — 켜고 끄는 컨트롤이 상태를 보조기기에 안 알리는 클래스를 고정한다(민 4375 곁 발견: 설정 알림 «앱 내» 토글에
 * role=switch · aria-checked 없음 → 화면 읽기엔 «단추»만 들리고 지금 켜졌는지 모름).
 *
 * ## 무엇을 거나(AST)
 * ① 클릭이 참/거짓을 뒤집는 요소(onClick이 `setX(!x)` · `setX((v) => !v)` · `toggle…(` · `onToggle…` · `onClick={toggle…}` 모양)인데
 *    상태 속성이 하나도 없음 — aria-pressed · aria-checked · aria-expanded · aria-selected · role(switch · checkbox · radio · tab ·
 *    menuitemcheckbox · menuitemradio · option) · 상태 prop(active · pressed · checked · selected — 부품이 속 단추에 싣는다고 봄).
 *    펼침 · 접기는 aria-expanded, 켜고 끄기 · 여럿 고르기는 aria-pressed(또는 role=switch/checkbox + aria-checked).
 *    scripts/stateless-toggle-baseline.json 두 칸:
 *    - `allow`(허용목록 · 결함 아님): 누르면 할 일을 **글자로 말하는** 단추(«보관 보기 ↔ 숨기기» · «편집 ↔ 완료» · «읽음 표시») — 상태 속성을
 *      붙이면 같은 것을 두 번 말한다. 파일 + onClick 글자 조각 + 개수 + 까닭으로 요소를 가리킨다(줄 번호 아님).
 *    - `counts`(기준선 · 줄이기만): 첫 전수 때 남은 펼침 · 접기 등 «다른 부류»(→ #4380에서 0으로). 파일별 수를 넘으면 FAIL.
 *    aria-hidden 요소(뒤 가림막 등)는 보조기기에 안 보이므로 대상 밖.
 * ② 스위치 모양(rounded-full + w-8~12 + h-4~6) 클릭 요소는 role="switch" + aria-checked가 둘 다 있어야 한다 — 기준선 없음.
 * ③ [SID:4380] 하나 고르기 · 현재 항목: 클릭 단추(button · Button)의 className이 고름/지금 상태(selected · active · current · checked …)로
 *    갈리는데 상태 속성(aria-current · aria-selected · aria-pressed · aria-checked · role)이 없음 — 색으로만 «이게 골라짐»을 보이는 모양.
 *    JSON `selection` 칸이 기준선(줄이기만).
 *    ③-같음 [SID:4380 · PO 09:44Z]: className 삼항이 `A === B ?`이고 A나 B가 onClick 호출 인자로 넘어가는 단추(보기 방식 · 거르개 ·
 *    탭 · 기간 · 형식 고르기 — «누르면 이 값을 고르고, 같으면 색이 바뀜»). 같은 `selection` 기준선에 든다. 오탐(같음 비교가 «고름»이
 *    아닌 것 — 예 `copiedInviteId === invite.id` = 복사됨 표시)은 `allow`에 `"rule": "selection-class"`로 까닭과 함께 뺀다.
 *
 * ## 이 가드가 «못 잡는» 것(초록 = «다 봤다»로 읽지 않게)
 *   ㉠ 상태 prop을 받는 부품이 속 단추에 aria-pressed 등을 안 싣는 모양(doc-editor BubbleButton · ToolbarButton 류) — 부품 테스트로 잠근다.
 *   ㉡ 뒤집기가 이름 붙은 핸들러 안에 숨은 모양(`onClick={handleClick}` 속에서 setX(!x)) — 이름에 toggle이 없으면 못 본다.
 *   ㉢ 하나 고르기 · 현재 항목은 ③의 두 모양(이름 붙은 불리언 · 같음 비교 + onClick 인자)만 본다 — `isSelected(x)` 같은 함수 호출 ·
 *      cn()의 객체 키 · 비교 값이 onClick에 안 넘어가는 모양(다른 곳에서 고름)은 못 본다.
 *   ㉣ 상태 속성의 **값**이 맞는지(켜졌는데 false 등)는 안 본다 — 있다/없다만.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TOGGLE = [
  /\bset\w+\(\s*!\s*[\w.]+/,
  /\bset\w+\(\s*\(?\s*\w*\s*\)?\s*=>\s*!/,
  /toggle\w*\s*\(/i, // handleToggleX( 처럼 이름 가운데 든 것도(낱말 경계 없음)
  /\bon\w*(Change|Toggle)\s*\(\s*!/,
  /\bonToggle\w*\b/,
  /^\{\s*\w*toggle\w*\s*\}$/i,
];
const STATE_ATTRS = ['aria-pressed', 'aria-checked', 'aria-expanded', 'aria-selected', 'aria-current', 'active', 'pressed', 'checked', 'selected'];
// ③ 고름/지금 상태로 갈리는 className(삼항 · && 앞에 그 이름)
const SELECTION_CLASS = /\b(is)?(active|selected|current|checked|pressed)\b\s*(\?|&&)/i;
// ③-같음: className 삼항 `A === B ?`(값 · 문자열 · 숫자) — A나 B가 onClick 호출 인자에 그대로 들면 «고르는 단추».
const EQUALITY_CLASS = /([\w.]+|'[^']*'|"[^"]*")\s*===\s*([\w.]+|'[^']*'|"[^"]*")\s*\?/g;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** className이 onClick 인자와 같음 비교로 갈리나(③-같음). */
export function equalitySelection(cls: string, onClick: string): boolean {
  for (const m of cls.matchAll(EQUALITY_CLASS)) {
    for (const side of [m[1], m[2]]) {
      // 인자 자리: 여는 괄호 뒤(앞 인자 뒤 쉼표 포함) — `setX(v)` · `onSelect(doc.slug)` · `handle(a, v)` · `switchTo(2)`.
      if (new RegExp(`\\([^()]*(?<![\\w.])${escapeRe(side)}(?![\\w.])`).test(onClick)) return true;
    }
  }
  return false;
}
const ROLES = /^(switch|checkbox|radio|tab|menuitemcheckbox|menuitemradio|option)$/;
const SWITCH_SHAPE = (cls: string) => /rounded-full/.test(cls) && /\bw-(8|9|10|11|12)\b/.test(cls) && /\bh-(4|5|6)\b/.test(cls);

export interface ToggleRef {
  rule: 'stateless-toggle' | 'switch-shape' | 'selection-class';
  file: string;
  line: number;
  tag: string;
  onClick: string;
}

export interface AllowEntry {
  file: string;
  match: string;
  count: number;
  why: string;
  /** 어느 규칙의 요소를 빼나 — 없으면 ①(stateless-toggle). ③ 오탐은 "selection-class". */
  rule?: 'stateless-toggle' | 'selection-class';
}

export function scanContent(content: string, file: string): ToggleRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const refs: ToggleRef[] = [];
  const visit = (n: ts.Node): void => {
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
    if (open) {
      const attrs = new Map<string, ts.JsxAttribute>();
      let spread = false;
      for (const a of open.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) spread = true;
        else attrs.set(a.name.getText(sf), a);
      }
      const onClick = attrs.get('onClick')?.initializer?.getText(sf);
      const hidden = /^aria-hidden(=("true"|\{true\}))?$/.test(attrs.get('aria-hidden')?.getText(sf).replace(/\s+/g, '') ?? '');
      if (onClick !== undefined && !spread && !hidden) {
        const roleInit = attrs.get('role')?.initializer;
        const role = roleInit && ts.isStringLiteral(roleInit) ? roleInit.text : '';
        const line = sf.getLineAndCharacterOfPosition(open.getStart(sf)).line + 1;
        const tag = open.tagName.getText(sf);
        const cls = attrs.get('className')?.initializer?.getText(sf) ?? '';
        if (SWITCH_SHAPE(cls) && !(role === 'switch' && attrs.has('aria-checked'))) refs.push({ rule: 'switch-shape', file, line, tag, onClick });
        else if (TOGGLE.some((re) => re.test(onClick)) && !STATE_ATTRS.some((k) => attrs.has(k)) && !ROLES.test(role)) {
          refs.push({ rule: 'stateless-toggle', file, line, tag, onClick });
        } else if (/^(button|Button)$/.test(tag) && (SELECTION_CLASS.test(cls) || equalitySelection(cls, onClick)) && !STATE_ATTRS.some((k) => attrs.has(k)) && !ROLES.test(role)) {
          refs.push({ rule: 'selection-class', file, line, tag, onClick });
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return refs;
}

const MIN_EXPECTED_FILES = 400;

export function scanRepo(root: string): ToggleRef[] {
  const out: ToggleRef[] = [];
  let files = 0;
  const walkDir = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walkDir(full); continue; }
      if (!e.name.endsWith('.tsx') || /\.(test|spec|stories)\.tsx$/.test(e.name)) continue;
      files += 1;
      out.push(...scanContent(readFileSync(full, 'utf8'), path.relative(root, full).split(path.sep).join('/')));
    }
  };
  walkDir(root);
  if (files < MIN_EXPECTED_FILES) throw new Error(`FAIL: 검사 대상 .tsx가 ${files}개뿐(root=${root}) — 가드가 헛돌고 있다.`);
  return out;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '../src');
const BASELINE_PATH = path.resolve(HERE, 'stateless-toggle-baseline.json');

/** 허용목록에 든 요소를 뺀다 — 항목마다 그 파일에서 onClick 글자에 match가 든 것을 count개까지. 모자라면(없어진 자리) stale로 돌려준다. */
export function applyAllow(refs: ToggleRef[], allow: AllowEntry[]): { rest: ToggleRef[]; stale: AllowEntry[] } {
  let rest = [...refs];
  const stale: AllowEntry[] = [];
  for (const a of allow) {
    let left = a.count;
    rest = rest.filter((r) => {
      if (left > 0 && r.rule === (a.rule ?? 'stateless-toggle') && r.file === a.file && r.onClick.includes(a.match)) { left -= 1; return false; }
      return true;
    });
    if (left > 0) stale.push(a);
  }
  return { rest, stale };
}

export function countsOf(refs: ToggleRef[], rule: ToggleRef['rule'] = 'stateless-toggle'): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of refs) if (r.rule === rule) m.set(r.file, (m.get(r.file) ?? 0) + 1);
  return m;
}

export function loadBaseline(file = BASELINE_PATH): { counts: Map<string, number>; selection: Map<string, number>; allow: AllowEntry[] } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { counts?: Record<string, number>; selection?: Record<string, number>; allow?: AllowEntry[] };
  return { counts: new Map(Object.entries(parsed.counts ?? {})), selection: new Map(Object.entries(parsed.selection ?? {})), allow: parsed.allow ?? [] };
}

function main(): number {
  let refs: ToggleRef[];
  try {
    refs = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const { counts: baseline, selection: selBaseline, allow } = loadBaseline();
  const { rest, stale: staleAllow } = applyAllow(refs, allow);
  refs = rest;
  const counts = countsOf(refs);
  const shape = refs.filter((r) => r.rule === 'switch-shape');
  const over = [...counts].filter(([f, n]) => n > (baseline.get(f) ?? 0));
  const selCounts = countsOf(refs, 'selection-class');
  const selOver = [...selCounts].filter(([f, n]) => n > (selBaseline.get(f) ?? 0));
  const selStale = [...selBaseline].filter(([f, n]) => (selCounts.get(f) ?? 0) < n);
  const stale = [...baseline].filter(([f, n]) => (counts.get(f) ?? 0) < n);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`[4379] 상태 없는 뒤집기 클릭 ${total}건(${counts.size}파일 · 기준선 ${[...baseline.values()].reduce((a, b) => a + b, 0)}) · 스위치 모양 상태 없음 ${shape.length}건 — 못 잡는 것은 머리 주석 ㉠~㉣`);
  if (staleAllow.length) console.log(`  허용목록 중 안 맞은 항목 ${staleAllow.length}개(자리가 없어졌거나 바뀜 — 목록에서 빼기): ${staleAllow.map((a) => `${a.file} «${a.match}»`).join(' · ')}`);
  if (selStale.length) console.log(`  ③ 기준선보다 줄어든 파일 ${selStale.length}개 — selection 숫자를 내려 두면 되살림을 막는다: ${selStale.map(([f]) => f).join(' · ')}`);
  for (const [f, n] of selOver) {
    console.error(`  - ${f}: 고름 상태 클래스 ${n}건(기준선 ${selBaseline.get(f) ?? 0}) — 지금 위치면 aria-current, 세그먼트 · 여럿 고르기면 aria-pressed, 하나 고르기면 role=radio + aria-checked`);
    for (const r of refs.filter((x) => x.rule === 'selection-class' && x.file === f)) console.error(`      ${f}:${r.line} <${r.tag}>`);
  }
  if (stale.length) console.log(`  기준선보다 줄어든 파일 ${stale.length}개 — 기준선 숫자를 내려 두면 되살림을 막는다: ${stale.map(([f]) => f).join(' · ')}`);
  for (const r of shape) console.error(`  - ${r.file}:${r.line} <${r.tag}> — 스위치 모양: role="switch" + aria-checked={켜짐}`);
  for (const [f, n] of over) {
    console.error(`  - ${f}: ${n}건(기준선 ${baseline.get(f) ?? 0}) — 켜고 끄기 · 여럿 고르기면 aria-pressed(또는 role=switch/checkbox + aria-checked), 펼침이면 aria-expanded`);
    for (const r of refs.filter((x) => x.rule === 'stateless-toggle' && x.file === f)) console.error(`      ${f}:${r.line} <${r.tag}>`);
  }
  return shape.length || over.length || selOver.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-counts')) {
    const rest = applyAllow(scanRepo(SRC_ROOT), loadBaseline().allow).rest;
    const sorted = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));
    process.stdout.write(JSON.stringify({ counts: sorted(countsOf(rest)), selection: sorted(countsOf(rest, 'selection-class')) }, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
