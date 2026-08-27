// story #2210 — i18n 키가 코드에는 있는데 번역 파일에 없으면(next-intl 기본
// getMessageFallback=namespace.key 리터럴 반환·콘솔 에러만) 사용자는 화면에서
// "common.loadMore" 같은 키 이름을 그대로 본다. 조용히 실패하고 아무도 몰랐던 자리라
// (30개 누적 확인됨) — 코드가 참조하는 키가 messages/{ko,en}.json에 없으면 CI가 여기서
// 빨개진다.
//
// ⛔이 가드가 못 잡는 것(고의로 남겨둔 한계, 다음 사람이 "왜 저건 못 잡았나"로 되돌아오지
// 않도록 명시 — 구멍의 "크기"까지 함께 잰다, 2026-07-27):
//   ① 템플릿 리터럴로 조합되는 키 — `t(\`catalogSeverity_${severity}\`)` 같은 동적 키는
//      정적 정규식으로 값을 못 구하므로 스캔 대상에서 제외된다.
//      ⭐실측(별도 스크립트로 재사용 가능한 방법 동일 적용): 이 시점 기준 **55곳**
//      (~20개 파일 — agent-hitl-policy-editor.tsx 12곳·agent-runs-list.tsx 4곳 등,
//      나머지는 파일당 1~3곳으로 분산). 바늘구멍이 아니라 실질적인 사각지대다 —
//      다음 반복작업으로 "동적 키 접두어(`catalogSeverity_`, `workflowRolloutAddedRules`
//      류)를 소스에서 추출해 접두어 일치로 존재만 확인" 2차 스캔을 별도 후보로 남긴다.
//   ② apps/web/src 밖 범위 — 이 모노레포에는 현재 apps/web이 유일한 앱이라(다른 앱
//      디렉터리 자체가 없음, 2026-07-27 확인) 지금은 사실상 구멍이 아니다. 새 앱이
//      추가되면 이 캐비엇이 다시 유효해진다.
//
// story #3156 — 이 가드의 파서(stripComments·훅 바인딩 추출·extractKeyUsages)는
// `scripts/check-i18n-keys.js`(CI 스크립트)와 완전 별개 독립 구현이었다. #3149(PR#3558)에서
// 실증: 멤버접근 오귀속 결함을 한쪽만 고치자 다른 쪽이 같은 오탐으로 계속 붉혔다 — 파서를
// `scripts/i18n-key-parser.js`(공유 모듈)로 일원화해 두 소비처가 같은 구현을 import한다.
// 파서 자체의 회귀가드(extractKeyUsages 멤버접근 제외 등)는 `scripts/i18n-key-parser.test.js`
// 로 이관됐다 — 여기 남기지 않는다(중복 방지, 그 파일이 정본).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// story #3156: repo-root scripts/(node CJS, apps/web 워크스페이스 밖)의 공유 파서.
// moduleResolution:bundler+allowJs라 vitest/tsc 양쪽에서 해석 가능(tsconfig.json의
// @sprintable/* 크로스-패키지 import와 동일 패턴).
import { stripComments, extractHookBindings, extractKeyUsages } from '../../../../scripts/i18n-key-parser.js';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const SRC_ROOT = path.resolve(__dirname, '..');

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

function collectMissingKeys(): { key: string; locations: string[] }[] {
  const referenced = new Map<string, Set<string>>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const text = stripComments(raw);
    const bindings = extractHookBindings(text);
    if (bindings.size === 0) continue;
    const rel = path.relative(SRC_ROOT, file);
    for (const [varName, ns] of bindings) {
      for (const key of extractKeyUsages(text, varName)) {
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
  it('apps/web/src의 모든 useTranslations(ns)(\'key\')/getTranslations(ns)(\'key\') 호출이 ko.json·en.json에 존재한다', () => {
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
