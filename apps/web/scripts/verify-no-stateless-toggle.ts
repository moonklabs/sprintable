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
 *
 * ## 이 가드가 «못 잡는» 것(초록 = «다 봤다»로 읽지 않게)
 *   ㉠ 상태 prop을 받는 부품이 속 단추에 aria-pressed 등을 안 싣는 모양(doc-editor BubbleButton · ToolbarButton 류) — 부품 테스트로 잠근다.
 *   ㉡ 뒤집기가 이름 붙은 핸들러 안에 숨은 모양(`onClick={handleClick}` 속에서 setX(!x)) — 이름에 toggle이 없으면 못 본다.
 *   ㉢ 하나 고르기 · 현재 항목(aria-selected · aria-current 없음)은 다른 부류라 대상 밖.
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
const STATE_ATTRS = ['aria-pressed', 'aria-checked', 'aria-expanded', 'aria-selected', 'active', 'pressed', 'checked', 'selected'];
const ROLES = /^(switch|checkbox|radio|tab|menuitemcheckbox|menuitemradio|option)$/;
const SWITCH_SHAPE = (cls: string) => /rounded-full/.test(cls) && /\bw-(8|9|10|11|12)\b/.test(cls) && /\bh-(4|5|6)\b/.test(cls);

export interface ToggleRef {
  rule: 'stateless-toggle' | 'switch-shape';
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
      if (left > 0 && r.rule === 'stateless-toggle' && r.file === a.file && r.onClick.includes(a.match)) { left -= 1; return false; }
      return true;
    });
    if (left > 0) stale.push(a);
  }
  return { rest, stale };
}

export function countsOf(refs: ToggleRef[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of refs) if (r.rule === 'stateless-toggle') m.set(r.file, (m.get(r.file) ?? 0) + 1);
  return m;
}

export function loadBaseline(file = BASELINE_PATH): { counts: Map<string, number>; allow: AllowEntry[] } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { counts?: Record<string, number>; allow?: AllowEntry[] };
  return { counts: new Map(Object.entries(parsed.counts ?? {})), allow: parsed.allow ?? [] };
}

function main(): number {
  let refs: ToggleRef[];
  try {
    refs = scanRepo(SRC_ROOT);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const { counts: baseline, allow } = loadBaseline();
  const { rest, stale: staleAllow } = applyAllow(refs, allow);
  refs = rest;
  const counts = countsOf(refs);
  const shape = refs.filter((r) => r.rule === 'switch-shape');
  const over = [...counts].filter(([f, n]) => n > (baseline.get(f) ?? 0));
  const stale = [...baseline].filter(([f, n]) => (counts.get(f) ?? 0) < n);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`[4379] 상태 없는 뒤집기 클릭 ${total}건(${counts.size}파일 · 기준선 ${[...baseline.values()].reduce((a, b) => a + b, 0)}) · 스위치 모양 상태 없음 ${shape.length}건 — 못 잡는 것은 머리 주석 ㉠~㉣`);
  if (staleAllow.length) console.log(`  허용목록 중 안 맞은 항목 ${staleAllow.length}개(자리가 없어졌거나 바뀜 — 목록에서 빼기): ${staleAllow.map((a) => `${a.file} «${a.match}»`).join(' · ')}`);
  if (stale.length) console.log(`  기준선보다 줄어든 파일 ${stale.length}개 — 기준선 숫자를 내려 두면 되살림을 막는다: ${stale.map(([f]) => f).join(' · ')}`);
  for (const r of shape) console.error(`  - ${r.file}:${r.line} <${r.tag}> — 스위치 모양: role="switch" + aria-checked={켜짐}`);
  for (const [f, n] of over) {
    console.error(`  - ${f}: ${n}건(기준선 ${baseline.get(f) ?? 0}) — 켜고 끄기 · 여럿 고르기면 aria-pressed(또는 role=switch/checkbox + aria-checked), 펼침이면 aria-expanded`);
    for (const r of refs.filter((x) => x.rule === 'stateless-toggle' && x.file === f)) console.error(`      ${f}:${r.line} <${r.tag}>`);
  }
  return shape.length || over.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-counts')) {
    const counts = countsOf(applyAllow(scanRepo(SRC_ROOT), loadBaseline().allow).rest);
    process.stdout.write(JSON.stringify(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
