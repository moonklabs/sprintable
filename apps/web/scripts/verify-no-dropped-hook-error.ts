/**
 * story #4372 — 훅이 돌려주는 오류(error · loadError · loadFailed · …Failed)를 호출처가 버려, 실패가 화면에서 «없음»으로 보이던 클래스.
 * 같은 훅의 다른 호출처는 오류를 그리는데 한 곳만 안 읽으면, 같은 실패가 화면마다 다른 말이 된다(조직 전환 실패가 말없이 되돌아감 · 복사 실패 무표시 등).
 *
 * 판별(AST · apps/web/src 전체):
 * 1. 훅 = `function useX` · `const useX = (…) =>` 로 정의되고, 자기 본문의 `return { … }`(안쪽 함수 제외)에 오류 키가 있는 것.
 *    오류 키 = 이름이 error · Error · failed · Failed 로 끝나는 키. 동작 함수(dismiss… · set… · clear… · reset… · on… · handle… · retry…)는 제외.
 * 2. 호출처 = `const { … } = useX(…)` 또는 `const x = useX(…)`.
 *    «읽음»은 그 호출이 만든 **바인딩**을 **호출을 품은 함수 범위 안에서** 값으로 쓴 것만(까디르 4755 ② — 파일 전체 이름 검색이면
 *    같은 파일 다른 컴포넌트의 같은 이름 `error` · `loadFailed`가 버린 자리를 가렸다).
 *    - 구조분해: 오류 키를 꺼낸 지역 이름(별칭 포함)을 그 범위에서 써야 함. …rest면 rest를 써야 함.
 *    - 이름 하나로 받기: 그 범위에서 `x.키` · `x?.키` · 통째로 넘김(JSX 속성 값 · 호출 인자 · 펼침) · 뒤 구조분해로 꺼내 쓴 것.
 * 3. 의도된 저하는 ALLOWLIST에 이유와 함께(파일 · 훅 · 키). 목록에 있는데 더는 안 걸리면 stale로 FAIL(줄이기만).
 *
 * **아직 못 보는 자리**(범위를 밝혀 둔다 · 까디르 4755):
 *   - index.ts 재수출로 들여온 훅 — import 경로가 정의 파일이 아니면 해소하지 않고 건너뛴다.
 *   - 식 본문(`=> ({ … })`) · 배열/튜플을 돌려주는 훅 — `return { … }` 객체 리터럴의 키만 뽑는다.
 *   - 훅 결과를 다른 이름으로 옮겨 담은 뒤 읽는 모양(`const r = useX(); const e = r;`).
 *   - 같은 함수 안 안쪽 블록의 같은 이름 가림(shadowing) — 범위는 함수 단위.
 *   - 읽었는지까지만 본다 — 그렸는지는 자리마다 테스트.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ERROR_KEY = /(error|Error|failed|Failed)$/;
const ACTION_PREFIX = /^(dismiss|set|clear|reset|on|handle|retry)[A-Z]/;
export const isErrorKey = (k: string) => ERROR_KEY.test(k) && !ACTION_PREFIX.test(k);

/** 의도된 저하 — `파일::훅::키` → 이유. */
export const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['hooks/use-member-name-fallback.ts::useAsyncResource::loadFailed', '대체 이름 훅 — 이름 조회가 실패하면 대체 이름(id 앞자리 등)으로 그리는 것이 정의된 동작'],
  ['hooks/use-org-domain-labels.ts::useAsyncResource::loadFailed', '대체 라벨 훅 — 조회 실패면 기본 라벨로 그리는 것이 정의된 동작'],
  ['components/docs/doc-status-rail.tsx::useDocGateData::error', '이 훅의 error는 결재 동작(승인 · 반려) 오류 — :257 감사 목록은 동작이 없어 해당 없음(동작하는 레일은 :144에서 읽음)'],
  ['components/chat-v3/chat-v3-screen.tsx::useTodaySnapshot::loadError', '도달 0 — /chat v3는 CHAT_V3_ENABLED가 켜진 곳만. dev 실측(PO 2026-09-28 00:42Z · qa-live-probe 로그인 GET): 상태 200 + not-found 화면. 켜는 날 이 줄을 지우고 today-v3처럼 불러오기 실패 표시'],
]);

export interface DroppedRef { file: string; line: number; hook: string; key: string }

type Src = { rel: string; sf: ts.SourceFile };

/** `정의 파일::훅 이름` → 오류 키. 이름이 같은 다른 훅(chat-v3 use-me.ts의 useMe · connect-rules-v3 화면 안 useMe)을 섞지 않게 파일까지 키에. */
function hookErrorKeys(sources: Src[]): Map<string, string[]> {
  const hooks = new Map<string, string[]>();
  for (const { rel, sf } of sources) {
    const visit = (n: ts.Node): void => {
      let name: string | undefined;
      let body: ts.ConciseBody | undefined;
      if (ts.isFunctionDeclaration(n) && n.name && /^use[A-Z]/.test(n.name.text)) { name = n.name.text; body = n.body; }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^use[A-Z]/.test(n.name.text) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.text; body = n.initializer.body; }
      if (name && body && ts.isBlock(body)) {
        const keys = new Set<string>();
        const scan = (m: ts.Node): void => {
          if (ts.isReturnStatement(m) && m.expression && ts.isObjectLiteralExpression(m.expression)) {
            for (const p of m.expression.properties) {
              const k = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
              if (k && isErrorKey(k)) keys.add(k);
            }
          }
          if (!ts.isFunctionLike(m)) m.forEachChild(scan);
        };
        body.forEachChild(scan);
        if (keys.size) hooks.set(`${rel}::${name}`, [...(hooks.get(`${rel}::${name}`) ?? []), ...keys]);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return hooks;
}

/** 이 선언을 품은 가장 가까운 함수의 본문(없으면 파일) — «읽음»은 이 범위 안에서만 찾는다(같은 파일 다른 함수의 같은 이름에 속지 않게 · 까디르 4755 ②). */
function scopeOf(decl: ts.Node): ts.Node {
  let p: ts.Node | undefined = decl.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isFunctionLike(p) && (p as ts.FunctionLikeDeclaration).body) return (p as ts.FunctionLikeDeclaration).body!;
    p = p.parent;
  }
  return decl.getSourceFile();
}

/** 이름이 «값으로» 쓰인 자리들(선언 자리 · 속성 이름 자리는 뺌). */
function valueRefs(scope: ts.Node, name: string, declName: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name && n !== declName) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isBindingElement(p) && (p.propertyName === n || p.name === n)) || ts.isJsxAttribute(p) || (ts.isVariableDeclaration(p) && p.name === n)
        || (ts.isParameter(p) && p.name === n);
      if (!isPropName) out.push(n);
    }
    n.forEachChild(visit);
  };
  visit(scope);
  return out;
}

/** 이름 하나로 받은 훅 결과 x에서 키를 읽었는가 — x.키 · x?.키 · 통째로 넘김(JSX 속성 값 · 호출 인자 · 펼침) · 뒤 구조분해로 꺼내 쓴 것. */
function readsFromWhole(scope: ts.Node, x: string, declName: ts.Node, key: string): boolean {
  for (const ref of valueRefs(scope, x, declName)) {
    const p = ref.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === ref && p.name.text === key) return true;
    if ((ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) || (ts.isCallExpression(p) && p.arguments.includes(ref)) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isJsxSpreadAttribute(p)) return true;
    if (ts.isVariableDeclaration(p) && p.initializer === ref && ts.isObjectBindingPattern(p.name) && readsFromPattern(scope, p.name, key)) return true;
  }
  return false;
}

/** 구조분해에서 키를 꺼내 그 지역 이름을 실제로 썼는가(…rest면 rest를 쓴 것). */
function readsFromPattern(scope: ts.Node, pattern: ts.ObjectBindingPattern, key: string): boolean {
  for (const el of pattern.elements) {
    if (el.dotDotDotToken && ts.isIdentifier(el.name)) return valueRefs(scope, el.name.text, el.name).length > 0;
    const prop = (el.propertyName ?? el.name).getText();
    if (prop !== key) continue;
    if (ts.isIdentifier(el.name)) return valueRefs(scope, el.name.text, el.name).length > 0;
    return true; // 안쪽 구조분해({ error: { message } }) — 꺼냈으면 읽은 것
  }
  return false;
}

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
/** 호출한 이름 → 그 훅의 정의 파일. 같은 파일 정의가 먼저, 아니면 import 경로(`@/` · 상대). 못 찾으면 undefined(검사 안 함). */
function resolveHook(rel: string, sf: ts.SourceFile, name: string, hooks: Map<string, string[]>, files: Set<string>): string | undefined {
  if (hooks.has(`${rel}::${name}`)) return `${rel}::${name}`;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => e.name.text === name);
    if (!el) continue;
    const orig = (el.propertyName ?? el.name).text;
    const spec = st.moduleSpecifier.text;
    const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)) : undefined;
    if (!base) return undefined;
    for (const ext of EXTS) if (files.has(base + ext) && hooks.has(`${base + ext}::${orig}`)) return `${base + ext}::${orig}`;
    return undefined;
  }
  return undefined;
}

export function scanSources(sources: Src[]): DroppedRef[] {
  const hooks = hookErrorKeys(sources);
  const files = new Set(sources.map((x) => x.rel));
  const out: DroppedRef[] = [];
  for (const { rel, sf } of sources) {
    const visit = (n: ts.Node): void => {
      const callee = n.kind === ts.SyntaxKind.VariableDeclaration && (n as ts.VariableDeclaration).initializer && ts.isCallExpression((n as ts.VariableDeclaration).initializer!) && ts.isIdentifier(((n as ts.VariableDeclaration).initializer as ts.CallExpression).expression)
        ? (((n as ts.VariableDeclaration).initializer as ts.CallExpression).expression as ts.Identifier).text : undefined;
      const hookId = callee && /^use[A-Z]/.test(callee) ? resolveHook(rel, sf, callee, hooks, files) : undefined;
      if (ts.isVariableDeclaration(n) && hookId) {
        const hook = callee!;
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const scope = scopeOf(n);
        for (const key of hooks.get(hookId)!) {
          let read = true;
          if (ts.isObjectBindingPattern(n.name)) read = readsFromPattern(scope, n.name, key);
          else if (ts.isIdentifier(n.name)) read = readsFromWhole(scope, n.name.text, n.name, key);
          if (!read) out.push({ file: rel, line, hook, key });
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return out;
}

export const refKey = (r: DroppedRef) => `${r.file}::${r.hook}::${r.key}`;

export function judge(refs: DroppedRef[]): { fresh: DroppedRef[]; stale: string[] } {
  const seen = new Set(refs.map(refKey));
  return { fresh: refs.filter((r) => !ALLOWLIST.has(refKey(r))), stale: [...ALLOWLIST.keys()].filter((k) => !seen.has(k)) };
}

function loadSources(root: string): Src[] {
  const out: Src[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(full); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec|stories)\.tsx?$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
      out.push({ rel: path.relative(root, full).split(path.sep).join('/'), sf: ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, e.name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) });
    }
  };
  walk(root);
  return out;
}

function main(): number {
  const refs = scanSources(loadSources(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')));
  const { fresh, stale } = judge(refs);
  console.log(`[4372] 훅 오류 키를 버리는 호출처 스캔 — 검출 ${refs.length}건 · ALLOWLIST ${ALLOWLIST.size} · 신규 ${fresh.length}건 · stale ${stale.length}건`);
  for (const r of fresh) console.error(`  - ${r.file}:${r.line} ${r.hook}()의 ${r.key}를 안 읽음 — 실패를 그리거나(같은 훅의 다른 호출처처럼) 의도된 저하면 ALLOWLIST에 이유와 함께`);
  for (const k of stale) console.error(`  - stale ALLOWLIST ${k} — 이제 읽는다면 목록에서 뺄 것`);
  return fresh.length || stale.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
