/**
 * story #4372 — 훅이 돌려주는 오류(error · loadError · loadFailed · …Failed)를 호출처가 버려, 실패가 화면에서 «없음»으로 보이던 클래스.
 * 같은 훅의 다른 호출처는 오류를 그리는데 한 곳만 안 읽으면, 같은 실패가 화면마다 다른 말이 된다(조직 전환 실패가 말없이 되돌아감 · 복사 실패 무표시 등).
 *
 * 판별(AST · apps/web/src 전체):
 * 1. 훅 = `function useX` · `const useX = (…) =>` 로 정의되고, 자기 본문의 `return { … }`(안쪽 함수 제외)에 오류 키가 있는 것.
 *    오류 키 = 이름이 error · Error · failed · Failed 로 끝나는 키. 동작 함수(dismiss… · set… · clear… · reset… · on… · handle… · retry…)는 제외.
 * 2. 호출처 = `const { … } = useX(…)` 또는 `const x = useX(…)`.
 *    - 구조분해: 오류 키가 없고 나머지(…rest)도 없으면 걸림.
 *    - 이름 하나로 받기: 그 파일에서 `x.키` · `x?.키` 로 안 읽고, x를 통째로 넘기지도 않으면(JSX 속성 값 · 호출 인자 · 펼침) 걸림.
 * 3. 의도된 저하는 ALLOWLIST에 이유와 함께(파일 · 훅 · 키). 목록에 있는데 더는 안 걸리면 stale로 FAIL(줄이기만).
 *
 * 못 보는 것: 훅 결과를 다른 이름으로 옮겨 담은 뒤 읽는 모양(`const r = useX(); const e = r;`) · 오류 키를 읽기만 하고 그리지 않는 모양
 * (읽었는지까지만 본다 — 그렸는지는 자리마다 테스트) · 컴포넌트가 아닌 곳에서 부르는 훅(규칙상 없음).
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

function passedWhole(sf: ts.SourceFile, id: string, decl: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === id && n !== (decl as ts.VariableDeclaration).name) {
      const p = n.parent;
      if ((ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) || (ts.isCallExpression(p) && p.arguments.includes(n)) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isJsxSpreadAttribute(p)) found = true;
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
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

/** `const { … } = x` 로 나중에 구조분해해 키를 꺼내면 읽은 것(connect-step:236 — rail을 통째로 받고 이어서 풀어 씀). */
function destructuredLater(sf: ts.SourceFile, id: string, key: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) && n.initializer.text === id && ts.isObjectBindingPattern(n.name)) {
      if (n.name.elements.some((e) => e.dotDotDotToken || (e.propertyName ?? e.name).getText(sf) === key)) found = true;
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

export function scanSources(sources: Src[]): DroppedRef[] {
  const hooks = hookErrorKeys(sources);
  const files = new Set(sources.map((x) => x.rel));
  const out: DroppedRef[] = [];
  for (const { rel, sf } of sources) {
    const text = sf.getText();
    const visit = (n: ts.Node): void => {
      const callee = n.kind === ts.SyntaxKind.VariableDeclaration && (n as ts.VariableDeclaration).initializer && ts.isCallExpression((n as ts.VariableDeclaration).initializer!) && ts.isIdentifier(((n as ts.VariableDeclaration).initializer as ts.CallExpression).expression)
        ? (((n as ts.VariableDeclaration).initializer as ts.CallExpression).expression as ts.Identifier).text : undefined;
      const hookId = callee && /^use[A-Z]/.test(callee) ? resolveHook(rel, sf, callee, hooks, files) : undefined;
      if (ts.isVariableDeclaration(n) && hookId) {
        const hook = callee!;
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        for (const key of hooks.get(hookId)!) {
          let read = true;
          if (ts.isObjectBindingPattern(n.name)) {
            const names = n.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
            const rest = n.name.elements.some((e) => e.dotDotDotToken);
            read = rest || names.includes(key);
          } else if (ts.isIdentifier(n.name)) {
            const id = n.name.text;
            read = new RegExp(`\\b${id}\\??\\.${key}\\b`).test(text) || passedWhole(sf, id, n) || destructuredLater(sf, id, key);
          }
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
