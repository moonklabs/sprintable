/**
 * story #4357 — 꺼진 조작(`disabled`)의 설명이 `title`(마우스 호버)에만 실리는 클래스를 고정한다. 터치 · 키보드 초점 · 화면 읽기에는
 * title이 안 닿아 «왜 꺼졌는지»를 모른다(유나 실측 · 디스패치 «에이전트를 먼저 선택하세요»). 처방 모양은 4348과 같다: 보이는 글 +
 * `aria-disabled` + `aria-describedby`.
 *
 * 판별(AST): 같은 JSX 요소에 `disabled`와 `title`이 함께 있고 `aria-describedby`가 없다(스프레드 속성이 있으면 모름 — 건너뜀).
 * title이 까닭인지 이름표인지는 기계로 못 가르므로 지금 있는 자리는 baseline(줄이기만 · 늘면 RED · 고쳐져 사라진 줄은 지울 것)이고,
 * 새로 생기는 자리는 즉시 RED다 — 까닭이면 보이는 글 + aria-describedby로, 아이콘 이름표면 aria-label로.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface TitleOnlyRef {
  file: string;
  line: number;
  tag: string;
  title: string;
}

export function scanContent(content: string, file: string): TitleOnlyRef[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const refs: TitleOnlyRef[] = [];
  function walk(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = new Map<string, ts.JsxAttribute>();
      for (const a of node.attributes.properties) if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(sf), a);
      const hasSpread = node.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));
      const title = attrs.get('title');
      if (attrs.has('disabled') && title?.initializer && !attrs.has('aria-describedby') && !hasSpread) {
        refs.push({
          file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          tag: node.tagName.getText(sf), title: title.initializer.getText(sf).replace(/\s+/g, ' '),
        });
      }
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return refs;
}

/** 줄 번호 없는 안정 키(인접 편집에 안 흔들리게). */
export function refKey(r: TitleOnlyRef): string {
  return `${r.file}::${r.tag}::${r.title}`;
}

export function scanRepo(root: string): TitleOnlyRef[] {
  const out: TitleOnlyRef[] = [];
  const walkDir = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walkDir(full); continue; }
      if (!e.name.endsWith('.tsx') || /\.(test|spec|stories)\.tsx$/.test(e.name)) continue;
      out.push(...scanContent(readFileSync(full, 'utf8'), path.relative(root, full).split(path.sep).join('/')));
    }
  };
  walkDir(root);
  return out;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.join(HERE, 'title-only-disabled-reason-baseline.json');

/** baseline = 키별 **개수**(까디르 4742 P2 — 집합으로 비교하면 같은 키의 자리가 하나로 뭉쳐, 같은 파일에 같은 모양을 하나 더 넣어도
 * 초록이고 중복 하나를 고쳐도 stale이 안 떴다). */
export function loadBaseline(): Map<string, number> {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { counts: Record<string, number> };
  return new Map(Object.entries(parsed.counts));
}

export function countByKey(refs: TitleOnlyRef[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of refs) m.set(refKey(r), (m.get(refKey(r)) ?? 0) + 1);
  return m;
}

/** 늘어난 키(지금 > baseline) = 신규 · 줄어든 키(지금 < baseline) = stale(baseline을 줄일 것). */
export function compare(found: Map<string, number>, baseline: Map<string, number>): { grown: string[]; shrunk: string[] } {
  const grown: string[] = [];
  const shrunk: string[] = [];
  for (const [k, n] of found) if (n > (baseline.get(k) ?? 0)) grown.push(`${k} (${baseline.get(k) ?? 0} → ${n})`);
  for (const [k, n] of baseline) if ((found.get(k) ?? 0) < n) shrunk.push(`${k} (${n} → ${found.get(k) ?? 0})`);
  return { grown, shrunk };
}

function main(): number {
  const refs = scanRepo(path.resolve(HERE, '../src'));
  const baseline = loadBaseline();
  const { grown, shrunk } = compare(countByKey(refs), baseline);
  const total = [...baseline.values()].reduce((a, b) => a + b, 0);
  console.log(`[4357] 꺼진 조작 · title만 설명 스캔 — 검출 ${refs.length}건 · baseline ${total}건(키 ${baseline.size}) · 늘어남 ${grown.length} · 줄어듦 ${shrunk.length}`);
  for (const g of grown) console.error(`  ❌ 늘어남 ${g} — 까닭이면 보이는 글 + aria-describedby(+ aria-disabled), 이름표면 aria-label`);
  for (const k of shrunk) console.error(`  ❌ 줄어듦(baseline 줄일 것) ${k}`);
  return grown.length || shrunk.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
