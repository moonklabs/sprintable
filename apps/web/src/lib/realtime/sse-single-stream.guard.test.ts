// story #4698 — 탭당 끝나지 않는 스트림은 **sse-multiplexer.ts 한 곳**에서만 열린다.
//
// 왜: 멀티플렉스를 «끔»으로 두면 화면마다(presence · chat · notifications) 독립 EventSource가 열려 한 탭에 스트림이 3~4개가 된다.
// 크롬은 끝나지 않는 높은 우선순위 요청이 3개 이상이면 낮은 우선순위 요청(대화 탭 청크 · 탭 프리패치)을 15~20초 붙잡는다(4698 에뮬 실측 ·
// ResourceScheduler). 그래서 «스트림 하나» 불변식을 설정 값이 아니라 코드 모양으로 고정한다 — 이 파일은 소스를 AST로 읽어 스트림을 여는 자리가
// 허용 목록 밖에 생기면 RED로 만든다(주석 · 타입 자리의 EventSource는 안 센다).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 끝나지 않는 이벤트 스트림을 **여는** 유일한 자리(클라이언트). */
const STREAM_OPENER = 'lib/realtime/sse-multiplexer.ts';
/** 스트림을 **내려주는** 서버 라우트 — Content-Type 문자열만 나온다(열지 않는다). */
const STREAM_SERVER = 'app/api/event-stream/route.ts';
/** 응답 본문을 reader로 읽는 자리 — 끝나는 응답(AI 요약)만 허용. 이유가 사라지면 이 항목도 지운다(아래 «낡은 항목 없음» 시험). */
const FINITE_READERS: Record<string, string> = {
  'hooks/use-ai-summarize.ts': 'AI 요약 응답은 끝나는 스트림(청크로 나눠 오다 닫힌다) — 이벤트 스트림이 아니다',
};

export interface StreamFinding { kind: 'new-EventSource' | 'EventSource-value' | 'event-stream-literal' | 'getReader'; line: number; text: string }

function inTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isExpression(p)) return false;
  }
  return false;
}

/** 소스에서 «스트림을 여는/읽는» 코드를 찾는다. 주석 · 타입 자리는 AST라 자연히 빠진다. */
export function findStreamCode(source: string, fileName = 'x.tsx'): StreamFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: StreamFinding[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n) && /(^|\.)EventSource$/.test(n.expression.getText(sf))) out.push({ kind: 'new-EventSource', line: at(n), text: n.getText(sf).slice(0, 80) });
    else if (ts.isIdentifier(n) && n.text === 'EventSource' && !inTypePosition(n)) {
      const p = n.parent;
      const isCtorOfNew = !!p && ts.isNewExpression(p) && p.expression === n;
      const isMemberName = !!p && ts.isPropertyAccessExpression(p) && p.name === n && !/(^|\.)(window|globalThis|self)$/.test(p.expression.getText(sf));
      const isDeclName = !!p && (ts.isPropertySignature(p) || ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name === n;
      if (!isCtorOfNew && !isMemberName && !isDeclName) out.push({ kind: 'EventSource-value', line: at(n), text: p ? p.getText(sf).slice(0, 80) : 'EventSource' });
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /\/api\/event-stream|text\/event-stream/.test(n.text)) {
      out.push({ kind: 'event-stream-literal', line: at(n), text: n.text.slice(0, 80) });
    } else if (ts.isTemplateHead(n) && /\/api\/event-stream|text\/event-stream/.test(n.text)) {
      out.push({ kind: 'event-stream-literal', line: at(n), text: n.text.slice(0, 80) });
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'getReader') {
      out.push({ kind: 'getReader', line: at(n), text: n.getText(sf).slice(0, 80) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

describe('story #4698 — 스트림을 여는 코드는 sse-multiplexer.ts 한 곳뿐', () => {
  const files = listSourceFiles(SRC_DIR);
  const rel = (f: string) => path.relative(SRC_DIR, f).split(path.sep).join('/');

  it('⭐멀티플렉서 밖에서 EventSource를 만들거나 /api/event-stream · text/event-stream을 다루는 코드가 0건이다', () => {
    expect(files.length).toBeGreaterThan(500); // 스캔이 실제로 소스 트리를 읽었다(빈 목록으로 통과하는 가짜 초록 방지)
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r === STREAM_OPENER) continue;
      for (const hit of findStreamCode(fs.readFileSync(f, 'utf-8'), f)) {
        if (hit.kind === 'getReader') continue; // 아래 시험이 따로 본다
        if (r === STREAM_SERVER && hit.kind === 'event-stream-literal') continue; // 내려주는 쪽의 Content-Type
        offenders.push(`${r}:${hit.line} [${hit.kind}] ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⭐본문을 reader로 읽는 코드(스트리밍 fetch)는 «끝나는 응답» 허용 목록 밖에 없다', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      for (const hit of findStreamCode(fs.readFileSync(f, 'utf-8'), f)) {
        if (hit.kind === 'getReader' && !(r in FINITE_READERS)) offenders.push(`${r}:${hit.line} ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('허용 목록에 낡은 항목이 없다 — 열쇠 파일이 실제로 있고 그 안에 해당 코드가 아직 있다', () => {
    const opener = findStreamCode(fs.readFileSync(path.join(SRC_DIR, STREAM_OPENER), 'utf-8'), STREAM_OPENER);
    expect(opener.some((h) => h.kind === 'new-EventSource')).toBe(true);
    const server = findStreamCode(fs.readFileSync(path.join(SRC_DIR, STREAM_SERVER), 'utf-8'), STREAM_SERVER);
    expect(server.some((h) => h.kind === 'event-stream-literal')).toBe(true);
    for (const f of Object.keys(FINITE_READERS)) {
      expect(findStreamCode(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'), f).some((h) => h.kind === 'getReader')).toBe(true);
    }
  });
});

describe('가드의 검출 로직 자체(양성 · 음성 대조)', () => {
  it('양성: new EventSource · 별칭으로 꺼내 쓰기 · 경로 문자열 · 스트리밍 fetch · window.EventSource는 잡힌다', () => {
    expect(findStreamCode(`const s = new EventSource('/x');`).map((h) => h.kind)).toContain('new-EventSource');
    expect(findStreamCode(`const ES = EventSource; const s = new ES('/x');`).map((h) => h.kind)).toContain('EventSource-value');
    expect(findStreamCode(`const u = new URL('/api/event-stream', origin);`).map((h) => h.kind)).toContain('event-stream-literal');
    expect(findStreamCode('const u = `/api/event-stream?member_id=${id}`;').map((h) => h.kind)).toContain('event-stream-literal');
    expect(findStreamCode(`await fetch(u, { headers: { Accept: 'text/event-stream' } });`).map((h) => h.kind)).toContain('event-stream-literal');
    expect(findStreamCode(`const r = (await fetch(u)).body!.getReader();`).map((h) => h.kind)).toContain('getReader');
    expect(findStreamCode(`const s = new window.EventSource('/x');`).map((h) => h.kind)).toContain('new-EventSource');
  });
  it('음성: 주석 · 타입 자리 · EventSource.CLOSED 상수 · 무관한 문자열은 안 잡는다', () => {
    expect(findStreamCode(`// new EventSource('/api/event-stream') 는 쓰지 않는다\n/* text/event-stream */\nexport const a = 1;`)).toEqual([]);
    expect(findStreamCode(`import { useRef } from 'react';\nconst r = useRef<EventSource | null>(null);\nfunction f(s: EventSource) { return s; }`)).toEqual([]);
    expect(findStreamCode(`const closed = es.readyState === EventSource.CLOSED;`).filter((h) => h.kind === 'new-EventSource')).toEqual([]);
    expect(findStreamCode(`const x = '/api/event-notifications/unread-count';`)).toEqual([]);
  });
});
