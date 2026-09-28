import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { ALLOWLIST, isErrorKey, judge, scanSources } from './verify-no-dropped-hook-error';

// story #4372 — 훅 오류 키를 버리는 호출처 가드. 양성(버림) · 음성(읽음 · 넘김 · 나중 구조분해 · …rest) · 같은 이름 다른 훅 · stale.
const src = (rel: string, code: string) => ({ rel, sf: ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) });
const HOOK = src('hooks/use-thing.ts', `export function useThing() { const x = 1; return { data: x, loadFailed: false, dismissThingFailed: () => {} }; }`);

describe('verify-no-dropped-hook-error', () => {
  it('오류 키 판정 — 동작 함수(dismiss…)는 아님', () => {
    expect(isErrorKey('loadFailed')).toBe(true);
    expect(isErrorKey('switchOrgError')).toBe(true);
    expect(isErrorKey('dismissCopyVerifyPromptFailed')).toBe(false);
    expect(isErrorKey('data')).toBe(false);
  });

  it('⭐구조분해에 오류 키가 없으면 걸림 · 이름 하나로 받고 안 읽어도 걸림', () => {
    const a = src('components/a.tsx', `import { useThing } from '@/hooks/use-thing'; export function A() { const { data } = useThing(); return data; }`);
    const b = src('components/b.tsx', `import { useThing } from '@/hooks/use-thing'; export function B() { const t = useThing(); return t.data; }`);
    expect(scanSources([HOOK, a, b]).map((r) => `${r.file}:${r.key}`)).toEqual(['components/a.tsx:loadFailed', 'components/b.tsx:loadFailed']);
  });

  it('읽음 · 통째로 넘김 · 나중 구조분해 · …rest는 안 걸림', () => {
    const files = [
      src('c/read.tsx', `import { useThing } from '@/hooks/use-thing'; export function R() { const { data, loadFailed } = useThing(); return loadFailed ? 0 : data; }`),
      src('c/dot.tsx', `import { useThing } from '@/hooks/use-thing'; export function D() { const t = useThing(); return t?.loadFailed; }`),
      src('c/pass.tsx', `import { useThing } from '@/hooks/use-thing'; export function P() { const t = useThing(); return <X thing={t} />; }`),
      src('c/later.tsx', `import { useThing } from '@/hooks/use-thing'; export function L() { const t = useThing(); const { loadFailed } = t; return loadFailed; }`),
      src('c/rest.tsx', `import { useThing } from '@/hooks/use-thing'; export function S() { const { data, ...rest } = useThing(); return <X {...rest} d={data} />; }`),
    ];
    expect(scanSources([HOOK, ...files])).toEqual([]);
  });

  it('이름이 같은 다른 훅을 섞지 않는다 — 정의(같은 파일 → import 경로)로 가름', () => {
    const local = src('c/local.tsx', `function useThing() { return { loadError: false }; } export function Z() { const { loadError } = useThing(); return loadError; }`);
    const imported = src('c/imp.tsx', `import { useThing } from '@/hooks/use-thing'; export function Y() { const { loadFailed } = useThing(); return loadFailed; }`);
    expect(scanSources([HOOK, local, imported])).toEqual([]);
  });

  it('ALLOWLIST에 있는데 더는 안 걸리면 stale', () => {
    expect(judge([]).stale).toEqual([...ALLOWLIST.keys()]);
  });

  // 까디르(4755 ②) — «읽음»이 파일 전체 이름 검색이면 같은 파일 다른 컴포넌트의 같은 이름이 버린 자리를 가린다. 범위는 호출을 품은 함수.
  it('⭐한 파일에 컴포넌트 둘 — 꺼내 놓고 안 쓴 쪽은 걸림(옆 컴포넌트가 같은 이름을 써도)', () => {
    const f = src('c/two.tsx', `import { useThing } from '@/hooks/use-thing';
      export function Uses() { const { data, loadFailed } = useThing(); return loadFailed ? null : data; }
      export function Drops() { const { data, loadFailed } = useThing(); return data; }`);
    expect(scanSources([HOOK, f]).map((r) => `${r.line}:${r.key}`)).toEqual(['3:loadFailed']);
  });

  it('⭐한 파일에 컴포넌트 둘 — 같은 이름 t로 받아 한쪽만 t.loadFailed를 읽으면 다른 쪽은 걸림', () => {
    const f = src('c/two-whole.tsx', `import { useThing } from '@/hooks/use-thing';
      export function Reads() { const t = useThing(); return t.loadFailed ? null : t.data; }
      export function Drops() { const t = useThing(); return t.data; }`);
    expect(scanSources([HOOK, f]).map((r) => `${r.line}:${r.key}`)).toEqual(['3:loadFailed']);
  });
});
