// story #4327 — 이름이 바뀐 자원(RENAMED_RESOURCES: board → flow · glance → flow · standup → sprints)의 **옛 이름으로 주소를 조립**하면
// 매번 proxy가 301/307로 한 번 더 돌려보낸다(보드 필터를 고를 때마다 `/board` → `/flow` 왕복 하나 · 배포 30 실측). 앱 안 이동은
// 지금 이름으로 바로 간다. flat(`/board…`) · 프로젝트 박힘(`/${ws}/${proj}/board…`) 둘 다 센다.
// 4231 래칫(flat-link-project-param)은 «flat 목적지에 프로젝트가 실렸나»를 보고 `flatHref('/board…')`처럼 감싼 자리는 세지 않는다 —
// 이 가드는 «이름이 지금 이름인가»를 따로 본다.
// 셈법은 TypeScript AST(주석 · 문서 문자열 제외 · 문자열 / 템플릿 리터럴만).
// 세지 않는 자리: ① 리다이렉트 장치 자체(아래 MACHINERY — 옛 이름을 받아 새 이름으로 보내는 곳) ② 이동이 아닌 판정(비교 연산 · `case` ·
// startsWith / endsWith / includes / match / test 인자 · 옛 주소를 알아보는 자리).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RENAMED_RESOURCES } from './legacy-resource-tables';

const SRC = path.resolve(__dirname, '..');
const OLD = Object.keys(RENAMED_RESOURCES);
// 뒤에 오는 것: 경로 끝 · `/` · `?` · `#` · 치환(`${qs}` — `/board${params.size ? `?…` : ''}` 꼴 · 첫 판이 이걸 놓쳐 정작 신고된 필터 자리를 못 셌다).
const SEG = `(?:${OLD.join('|')})(?=[/?#]|\\$\\{\\}|$)`;
const FLAT_RE = new RegExp(`^/${SEG}`);
const SCOPED_RE = new RegExp(`^/\\$\\{\\}/\\$\\{\\}/${SEG}`);
// 까디르 4696 — 머리만 보던 빈틈: 치환 **뒤 꼬리**(`${resolveAppUrl(null)}/glance`) · 절대 주소의 호스트 뒤(`https://x/board`)도 센다.
// 문자열 이어붙이기(`base + '/glance'`)는 그 조각 리터럴이 `/glance`로 시작해 FLAT_RE가 이미 센다.
const TAIL_RE = new RegExp(`(?:\\$\\{\\}|://[^/?#\\s]+)/${SEG}`);

/** 옛 이름을 받아 새 이름으로 보내는 장치 — 옛 이름을 알아야 하는 곳. */
const MACHINERY = new Set(['proxy.ts', 'lib/legacy-resource-tables.ts', 'lib/route-resolve.ts']);
/**
 * 이동이 아닌데 구조로 판정되지 않는 자리 — 이유와 함께(늘리지 않는 것이 원칙 · 새 예외는 PO 판단).
 * `TAB_ROOT_PREFIXES`는 주소를 **알아보는** 목록(태블릿 중앙폭 판정)이라 이동이 아니다. 다만 `/glance`는 리다이렉트 뒤 주소에 다시 나타나지
 * 않아 이미 아무것도 맞추지 않는 죽은 항목이다 — 고치면 `/flow`(데스크톱 화면)의 태블릿 레이아웃이 바뀌어 이 스토리 밖(발견만 · PO 보고).
 */
const EXEMPT: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
  { file: 'app/dashboard/dashboard-shell.tsx', literal: '/glance', reason: 'TAB_ROOT_PREFIXES — 주소 판정 목록(이동 아님) · 죽은 항목은 별건' },
];
const JUDGE_CALLS = new Set(['startsWith', 'endsWith', 'includes', 'match', 'test', 'indexOf']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') files(p, out); }
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 템플릿은 치환 자리를 `${}`로 펴서 머리 모양만 본다. */
function render(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `\${}${s.literal.text}`).join('');
  return null;
}

function isJudgement(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression) && ts.isPropertyAccessExpression(p.expression) && JUDGE_CALLS.has(p.expression.name.text)) return true;
  return false;
}

export function findRenamedResourceLinks(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const r = render(n);
    if (r !== null && (FLAT_RE.test(r) || SCOPED_RE.test(r) || TAIL_RE.test(r)) && !isJudgement(n)) {
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${r}`);
    }
    // 템플릿 안 조각은 위에서 통째로 봤으니 내려가지 않는다.
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scan(): string[] {
  const out: string[] = [];
  for (const abs of files(SRC)) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    if (MACHINERY.has(rel)) continue;
    out.push(...findRenamedResourceLinks(rel, readFileSync(abs, 'utf8')).filter((v) => !EXEMPT.some((e) => v.startsWith(`${rel}:`) && v.endsWith(` ${e.literal}`) && e.file === rel)));
  }
  return out;
}

describe('이름이 바뀐 자원은 지금 이름으로 조립한다(story #4327)', () => {
  const count = (src: string) => findRenamedResourceLinks('x.tsx', src).length;

  it('양성 — flat · 프로젝트 박힘 · 쿼리 · 감싼 자리 · 세 이름 전부', () => {
    expect(count('router.replace(`/${ws}/${proj}/board?${qs}`)')).toBe(1);
    expect(count("const h = flatHref('/board?story=1')")).toBe(1);
    expect(count('const h = withProject(`/board?story=${id}`)')).toBe(1);
    expect(count("<Link href='/glance' />")).toBe(1);
    expect(count('router.push(`/${a}/${b}/standup`)')).toBe(1);
    expect(count("const x = '/board'")).toBe(1);
    expect(count('router.replace(`/${ws}/${proj}/board${qs ? `?${qs}` : \'\'}`)'), '이름 바로 뒤 치환').toBe(1);
    // 까디르 4696 — 치환 뒤 꼬리 · 절대 주소 · 이어붙이기.
    expect(count('NextResponse.redirect(`${resolveAppUrl(null)}/glance`, 303)'), '치환 뒤 꼬리').toBe(1);
    expect(count('const u = `${origin}/board?x=${y}`'), '치환 뒤 꼬리 + 쿼리').toBe(1);
    expect(count("const u = 'https://app.example.com/standup'"), '절대 주소').toBe(1);
    expect(count("const u = resolveAppUrl(null) + '/glance'"), '이어붙이기').toBe(1);
  });

  it('음성 — 지금 이름 · 다른 단어(boards · standups) · 판정 · 주석 · API 경로', () => {
    expect(count('router.replace(`/${ws}/${proj}/flow?${qs}`)')).toBe(0);
    expect(count("const x = '/boards'")).toBe(0);
    expect(count("const x = '/standup-history'")).toBe(0);
    expect(count("if (pathname === '/board') {}")).toBe(0);
    expect(count("pathname.startsWith('/glance')")).toBe(0);
    expect(count("switch (p) { case '/board': break; }")).toBe(0);
    expect(count('// router.push(`/board`)')).toBe(0);
    expect(count("fetch('/api/board')")).toBe(0);
    expect(count('fetch(`${base}/api/board`)'), '치환 뒤 API 경로').toBe(0);
    expect(count('const u = `${origin}/flow`'), '치환 뒤 지금 이름').toBe(0);
    expect(count("const u = 'https://app.example.com/boards'"), '절대 주소 · 다른 단어').toBe(0);
  });

  it('⭐실 저장소 — 옛 이름 조립 0(proxy 등 리다이렉트 장치 제외)', () => {
    const v = scan();
    expect(v, v.join('\n')).toEqual([]);
  });

  it('장치 파일이 실제로 있다(이름 바뀜으로 예외가 헛돌지 않게)', () => {
    for (const f of MACHINERY) expect(statSync(path.join(SRC, f)).isFile(), f).toBe(true);
  });

  it('예외 표의 자리가 실제로 있다(고쳐지거나 옮겨지면 표에서 지운다 · 헛도는 예외 0)', () => {
    for (const e of EXEMPT) {
      const hits = findRenamedResourceLinks(e.file, readFileSync(path.join(SRC, e.file), 'utf8'));
      expect(hits.some((h) => h.endsWith(` ${e.literal}`)), `${e.file} ${e.literal}`).toBe(true);
    }
  });
});
