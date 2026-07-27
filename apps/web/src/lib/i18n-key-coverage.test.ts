// story #2210 — i18n 키가 코드에는 있는데 번역 파일에 없으면(next-intl 기본
// getMessageFallback=namespace.key 리터럴 반환·콘솔 에러만) 사용자는 화면에서
// "common.loadMore" 같은 키 이름을 그대로 본다. 조용히 실패하고 아무도 몰랐던 자리라
// (30개 누적 확인됨) — 코드가 참조하는 키가 messages/{ko,en}.json에 없으면 CI가 여기서
// 빨개진다.
//
// ⛔이 가드가 못 잡는 것(고의로 남겨둔 한계, 다음 사람이 "왜 저건 못 잡았나"로 되돌아오지
// 않도록 명시):
//   ① 템플릿 리터럴로 조합되는 키 — `t(\`catalogSeverity_${severity}\`)` 같은 동적 키는
//      정적 정규식으로 값을 못 구하므로 스캔 대상에서 제외된다.
//   ② apps/web/src 밖 범위 — 다른 앱(모바일·데스크톱 셸)의 i18n은 보지 않는다.
//
// 방법론(2026-07-27 교훈, 이 스토리 자체에서 확定): 소스 정적 스캔은 주석 스트립이
// 첫 단계다 — 안 걷으면 주석 속 옛 코드 설명 문장이 실호출로 오판된다(#2210 조사 중
// inbox.title 오탐 1건 실측).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const SRC_ROOT = path.resolve(__dirname, '..');

function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/"/g) || []).length
        + (before.match(/'/g) || []).length
        + (before.match(/`/g) || []).length;
      // 대략적 판별 — 앞부분 따옴표 개수 합이 짝수면(문자열 밖) //를 진짜 주석으로 본다.
      // i18n 호출 라인에는 //가 문자열 속에 섞이는 경우가 사실상 없어 이 근사로 충분하다.
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
  return out;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function hasKey(messages: unknown, dotted: string): boolean {
  const parts = dotted.split('.');
  let cur: unknown = messages;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string';
}

const ASSIGN_RE = /(\w+)\s*=\s*useTranslations\(\s*['"]([\w.]+)['"]\s*\)/g;

function collectMissingKeys(): { key: string; locations: string[] }[] {
  const referenced = new Map<string, Set<string>>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const text = stripComments(raw);
    const assigns = [...text.matchAll(ASSIGN_RE)];
    if (assigns.length === 0) continue;
    const rel = path.relative(SRC_ROOT, file);
    for (const [, varName, ns] of assigns) {
      const callRe = new RegExp(`\\b${varName}\\(\\s*['"]([\\w.]+)['"]`, 'g');
      for (const [, key] of text.matchAll(callRe)) {
        const full = `${ns}.${key}`;
        if (!referenced.has(full)) referenced.set(full, new Set());
        referenced.get(full)!.add(rel);
      }
    }
  }

  const missing: { key: string; locations: string[] }[] = [];
  for (const [key, files] of referenced) {
    if (!hasKey(ko, key) || !hasKey(en, key)) {
      missing.push({ key, locations: [...files] });
    }
  }
  return missing.sort((a, b) => a.key.localeCompare(b.key));
}

describe('i18n 키 커버리지 — 코드가 참조하는 키는 ko/en 양쪽에 다 있어야 한다 (#2210)', () => {
  it('apps/web/src의 모든 useTranslations(ns)(\'key\') 호출이 ko.json·en.json에 존재한다', () => {
    const missing = collectMissingKeys();
    if (missing.length > 0) {
      const report = missing.map((m) => `  ${m.key}  <-  ${m.locations.join(', ')}`).join('\n');
      throw new Error(
        `${missing.length}개 i18n 키가 코드엔 있는데 번역 파일(ko.json/en.json)엔 없다 — ` +
        `사용자는 화면에서 이 키 이름을 그대로 본다(#2210):\n${report}`,
      );
    }
    expect(missing).toEqual([]);
  });
});
