// story #4320 — BFF(서버 쪽 라우트 · 헬퍼)의 `fetch`에 `signal`이 없으면, 브라우저가 끊어도 백엔드 호출이 살아 있고 백엔드가 멈추면 BFF
// 요청이 붙잡힌다. 서버 쪽 파일(app/api · lib 중 'use client'가 아닌 것)의 `fetch(` 호출은 **`signal`을 넘겨야** 한다 — 백엔드 호출은
// `backendSignal(request)`(원 요청 취소 + 시간 제한) · 요청이 없거나 끝까지 가야 하는 호출은 `backendSignal(null)`(시간 제한만)에
// 이유 주석(`시간 제한만`)을 단다.
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

function hasSignal(init: ts.Expression | undefined): boolean {
  if (!init || !ts.isObjectLiteralExpression(init)) return false;
  return init.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'signal');
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
  const out: SignalViolation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') {
      if (!hasSignal(n.arguments[1])) out.push({ file, line: at(n), why: 'signal 없음' });
    }
    if (isRoute && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'backendSignal'
      && n.arguments[0]?.kind === ts.SyntaxKind.NullKeyword && !hasReason(text, n, sf)) {
      out.push({ file, line: at(n), why: `라우트 안 backendSignal(null)에 이유(«${REASON_MARK}») 없음` });
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

describe('BFF 서버 쪽 fetch — signal 필수(story #4320)', () => {
  const count = (src: string, file = 'app/api/x/route.ts') => findFetchSignalViolations(file, src).length;

  it('양성 — signal 없는 fetch(초기값 없음 · 있어도 signal 없음) · 이유 없는 backendSignal(null)', () => {
    expect(count('export async function GET(){ await fetch(`${FASTAPI_URL()}/api/v2/x`); }')).toBe(1);
    expect(count("export async function GET(){ await fetch(u, { method: 'POST', headers }); }")).toBe(1);
    expect(count("export async function GET(){ await fetch(u, init); }"), '초기값이 변수면 signal을 볼 수 없다 — 센다').toBe(1);
    expect(count('export async function GET(){ await fetch(u, { signal: backendSignal(null) }); }')).toBe(1);
  });

  it('음성 — signal 있음 · 이유 있는 backendSignal(null) · lib의 backendSignal(null)(요청 없음) · use client 모듈', () => {
    expect(count('export async function GET(request){ await fetch(u, { signal: backendSignal(request), method: "POST" }); }')).toBe(0);
    expect(count('export async function GET(){ await fetch(u, {\n  // story #4320 — 토큰 회전 — 시간 제한만.\n  signal: backendSignal(null),\n}); }')).toBe(0);
    expect(count('export async function GET(){ await fetch(u, { signal }); }'), '단축 속성').toBe(0);
    expect(count('export async function f(){ await fetch(u, { signal: backendSignal(null) }); }', 'lib/x.ts')).toBe(0);
    expect(count("'use client';\nexport async function f(){ await fetch(u); }", 'lib/x.ts')).toBe(0);
  });

  it('⭐실 저장소 — 서버 쪽 fetch 전부 signal · 라우트 안 시간 제한만은 이유 있음', () => {
    const v = scan();
    expect(v, v.map((x) => `${x.file}:${x.line} ${x.why}`).join('\n')).toEqual([]);
  });

  it('예외 파일이 실제로 있다(이름 바뀜으로 예외가 헛돌지 않게)', () => {
    for (const e of EXEMPT_FILES) expect(statSync(path.join(SRC, e.file)).isFile(), e.file).toBe(true);
  });
});
