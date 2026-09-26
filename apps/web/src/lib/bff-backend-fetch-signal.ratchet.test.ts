// story #4320 — BFF(서버 쪽 라우트 · 헬퍼)의 백엔드 호출은 **제한 있는 신호**를 가져야 한다. 신호가 없으면 브라우저가 끊어도 백엔드 호출이
// 살아 있고, 백엔드가 멈추면 BFF 요청이 붙잡힌다.
// 까디르 QA ④ — 예전 가드는 `signal` 속성이 있는지만 봐서 `signal: request.signal`(시간 제한 없음)도 통과했다. 이제:
//  R1 서버 쪽 파일의 **맨 fetch**는 공용 두 곳(lib/backend-fetch.ts · lib/fastapi-proxy.ts)과 아래 RAW_FETCH 표(흘려보내야 하는 자리)만 —
//     나머지 라우트 · 헬퍼는 `backendFetch`(시간 초과 → 503 봉투 · 본문까지 시한)를 쓴다.
//  R2 맨 fetch의 signal은 **제한 있는** 것: `backendSignal(…)` · `AbortSignal.timeout(…)` · 그 둘 중 하나를 품은 `AbortSignal.any([…])`
//     (같은 함수 안 `const x = …` 한 단계까지 따라간다). `request.signal` · 모르는 이름 · 신호 없음은 RED.
//  R3 라우트의 `backendFetch`는 `request`(원 요청 취소 전달)나 `timeLimitOnly: true`(한 번 쓰는 값 · 새 토큰 — 시간 제한만) 중 하나를
//     명시하고, `timeLimitOnly`에는 그 줄이나 윗줄에 이유(`시간 제한만`)를 단다. 공용 프록시의 `timeLimitOnly`도 같은 이유 규칙.
// 예외(백엔드가 아닌 외부 상류 · 이 카드 범위 밖 — 표로 남긴다): 아래 EXEMPT_FILES.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const ROOTS = ['app/api', 'lib'];
const REASON_MARK = '시간 제한만';

/** 백엔드가 아닌 외부 상류 — 시간 제한 · 취소는 각 클라이언트 몫(이 카드 범위 밖 · PR 표 참고). */
export const EXEMPT_FILES: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'lib/kms/provider.ts', reason: 'Cloud KMS · Vault(외부 키 관리) — 백엔드 아님' },
  { file: 'lib/auth/firebase-session.ts', reason: 'Firebase 공개 키 조회(외부) — 백엔드 아님' },
  { file: 'lib/support-widget/gateway-client.ts', reason: '지원 게이트웨이(별도 서비스) — 백엔드 아님' },
  { file: 'lib/llm/client.ts', reason: '외부 LLM 제공자 호출 — 자체 타이머(AbortController + setTimeout) · 재시도 · 백엔드 아님' },
];

/** 공용 백엔드 fetch 두 곳 — 맨 fetch가 있어도 되는 자리(대신 R2 제한 있는 신호). */
const FETCH_HELPERS = new Set(['lib/backend-fetch.ts', 'lib/fastapi-proxy.ts']);
/** 흘려보내야 해서(본문을 다 읽으면 안 되는) 맨 fetch를 쓰는 자리 — R2는 그대로 적용. */
export const RAW_FETCH: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'app/api/event-stream/route.ts', reason: 'SSE 중계 — 스트림을 그대로 흘려보낸다(backendFetch는 본문을 다 읽는다) · 신호는 원 요청 + 벽시계 상한' },
];

function serverFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) serverFiles(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function isClientModule(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client';
}

function propOf(init: ts.Expression | undefined, name: string): ts.ObjectLiteralElementLike | undefined {
  if (!init || !ts.isObjectLiteralExpression(init)) return undefined;
  return init.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === name);
}

/** 이름의 `const x = …` 초기값(같은 함수 · 바깥 블록들을 거슬러) — 한 단계만. */
function constInit(id: ts.Identifier): ts.Expression | undefined {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      for (const st of n.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === id.text) return d.initializer;
        }
      }
    }
  }
  return undefined;
}

/** 제한 있는 신호인가 — backendSignal(…) · AbortSignal.timeout(…) · 그것을 품은 AbortSignal.any([…]). */
export function isBoundedSignal(expr: ts.Expression | undefined, depth = 0): boolean {
  if (!expr || depth > 2) return false;
  if (ts.isIdentifier(expr)) return isBoundedSignal(constInit(expr), depth + 1);
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee) && callee.text === 'backendSignal') return true;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'AbortSignal') {
    if (callee.name.text === 'timeout') return true;
    if (callee.name.text === 'any') {
      const arr = expr.arguments[0];
      return !!arr && ts.isArrayLiteralExpression(arr) && arr.elements.some((e) => isBoundedSignal(e, depth + 1));
    }
  }
  return false;
}

function signalExpr(init: ts.Expression | undefined): ts.Expression | undefined {
  const p = propOf(init, 'signal');
  if (!p) return undefined;
  return ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
}

function isTrue(init: ts.Expression | undefined, name: string): ts.ObjectLiteralElementLike | undefined {
  const p = propOf(init, name);
  if (p && ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword) return p;
  return undefined;
}

/** 그 줄(또는 윗줄 · 같은 줄 블록 주석)에 이유 표시가 있나. */
function hasReason(text: string, node: ts.Node, sf: ts.SourceFile): boolean {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const lines = text.split('\n');
  return [lines[line], lines[line - 1]].some((l) => (l ?? '').includes(REASON_MARK));
}

export interface SignalViolation { file: string; line: number; why: string }

export function findFetchSignalViolations(file: string, text: string): SignalViolation[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (isClientModule(sf)) return [];
  const isRoute = file.startsWith('app/api/');
  const rawAllowed = FETCH_HELPERS.has(file) || RAW_FETCH.some((r) => r.file === file);
  const out: SignalViolation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      const init = n.arguments[1];
      if (name === 'fetch') {
        if (!rawAllowed) out.push({ file, line: at(n), why: '맨 fetch — backendFetch(시간 초과 → 503 · 본문까지 시한)로' });
        else if (!isBoundedSignal(signalExpr(init))) out.push({ file, line: at(n), why: '제한 없는 signal(backendSignal · AbortSignal.timeout · 그걸 품은 any만)' });
      }
      if (name === 'backendFetch' && isRoute) {
        const tlo = isTrue(init, 'timeLimitOnly');
        if (!propOf(init, 'request') && !tlo) out.push({ file, line: at(n), why: 'request도 timeLimitOnly도 없음(원 요청 취소 전달 여부를 명시)' });
        if (tlo && !hasReason(text, tlo, sf)) out.push({ file, line: at(n), why: `timeLimitOnly에 이유(«${REASON_MARK}») 없음` });
      }
      if (isRoute && /^proxyToFastapi/.test(name)) {
        const opts = n.arguments[n.arguments.length - 1];
        const tlo = isTrue(opts, 'timeLimitOnly');
        if (tlo && !hasReason(text, tlo, sf)) out.push({ file, line: at(n), why: `프록시 timeLimitOnly에 이유(«${REASON_MARK}») 없음` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scan(root = SRC): SignalViolation[] {
  const out: SignalViolation[] = [];
  for (const r of ROOTS) {
    for (const abs of serverFiles(path.join(root, r))) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (EXEMPT_FILES.some((e) => e.file === rel)) continue;
      out.push(...findFetchSignalViolations(rel, readFileSync(abs, 'utf8')));
    }
  }
  return out;
}

describe('BFF 서버 쪽 백엔드 호출 — 제한 있는 신호(story #4320 · 까디르 QA ④)', () => {
  const count = (src: string, file = 'app/api/x/route.ts') => findFetchSignalViolations(file, src).length;

  it('⭐양성 — 라우트의 맨 fetch(신호 있어도) · 제한 없는 신호(request.signal · 모르는 이름) · 이유 없는 시간 제한만', () => {
    expect(count('export async function GET(request){ await fetch(u, { signal: request.signal }); }'), '라우트 맨 fetch').toBe(1);
    expect(count('export async function f(request){ await fetch(u, { signal: request.signal }); }', 'lib/fastapi-proxy.ts'), 'request.signal(제한 없음)').toBe(1);
    expect(count('export async function f(){ await fetch(u, { signal: someSignal }); }', 'lib/fastapi-proxy.ts'), '모르는 이름').toBe(1);
    expect(count('export async function f(){ await fetch(u); }', 'lib/fastapi-proxy.ts'), '신호 없음').toBe(1);
    expect(count('export async function f(){ await fetch(u, { signal: AbortSignal.any([request.signal]) }); }', 'lib/fastapi-proxy.ts'), 'any 안에 제한 없음').toBe(1);
    expect(count('export async function GET(){ await backendFetch(u, {}); }'), 'request도 timeLimitOnly도 없음').toBe(1);
    expect(count('export async function GET(){ await backendFetch(u, { timeLimitOnly: true }); }'), '이유 없는 시간 제한만').toBe(1);
    expect(count("export async function POST(request){ return proxyToFastapiWrapped(request, '/x', { timeLimitOnly: true }); }"), '프록시 이유 없음').toBe(1);
    expect(count('export async function f(){ await fetch(u, { signal: x }); }', 'lib/other-helper.ts'), 'lib 헬퍼의 맨 fetch').toBe(1);
  });

  it('음성 — backendFetch(request) · 이유 있는 시간 제한만 · 공용 두 곳의 제한 있는 신호 · const 한 단계 · SSE 예외 · lib 헬퍼 backendFetch · use client', () => {
    expect(count('export async function GET(request){ await backendFetch(u, { request, method: "POST" }); }')).toBe(0);
    expect(count('export async function GET(){ await backendFetch(u, {\n  // story #4320 — 토큰 회전 — 시간 제한만.\n  timeLimitOnly: true,\n}); }')).toBe(0);
    expect(count("export async function POST(request){ return proxyToFastapiWrapped(request, '/x', {\n  // 결제 — 시간 제한만.\n  timeLimitOnly: true,\n}); }")).toBe(0);
    expect(count('export async function f(request){ await fetch(u, { signal: backendSignal(request, 1000) }); }', 'lib/fastapi-proxy.ts')).toBe(0);
    expect(count('export async function f(){ await fetch(u, { signal: AbortSignal.timeout(1000) }); }', 'lib/backend-fetch.ts')).toBe(0);
    expect(count('export async function GET(request){ const s = AbortSignal.any([request.signal, AbortSignal.timeout(9)]);\n await fetch(u, { signal: s }); }', 'app/api/event-stream/route.ts')).toBe(0);
    expect(count('export async function f(){ await backendFetch(u, {}); }', 'lib/x.ts'), 'lib 헬퍼(요청 없음)').toBe(0);
    expect(count("'use client';\nexport async function f(){ await fetch(u); }", 'lib/x.ts')).toBe(0);
  });

  it('⭐실 저장소 — 맨 fetch는 공용 두 곳 · SSE 예외뿐 · 신호는 전부 제한 있음 · 시간 제한만엔 이유', () => {
    const v = scan();
    expect(v, v.map((x) => `${x.file}:${x.line} ${x.why}`).join('\n')).toEqual([]);
  });

  it('예외 · 표의 파일이 실제로 있다(이름 바뀜으로 예외가 헛돌지 않게)', () => {
    for (const e of [...EXEMPT_FILES, ...RAW_FETCH]) expect(statSync(path.join(SRC, e.file)).isFile(), e.file).toBe(true);
  });
});
