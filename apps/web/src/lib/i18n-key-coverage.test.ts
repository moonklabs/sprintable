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

// story #3149(카디르 QA 실측·미르코 근본추적, PR#3558) — check-i18n-keys.js와 별개·독립
// 구현인 이 가드가 같은 결함을 그대로 갖고 있었다: `\b${varName}\(`의 워드바운더리는 '.'
// 앞에서도 통과해(`.`은 `\w`가 아님) 멤버접근(`acc.t('title')`)이 파일 자신의 로컬
// `t`(다른 네임스페이스에 바인딩)로 오귀속됐다. check-i18n-keys.js의 처방과 동형으로
// 룩비하인드에 `.`을 추가(`(?<![\w$.])`) — 멤버접근은 이제 로컬 varName 호출로 안 잡히고
// 기존 워드바운더리 방어(`get('x')`의 `t('x')`류)는 그대로 보존.
function extractKeyUsages(text: string, varName: string): string[] {
  const re = new RegExp(`(?<![\\w$.])${varName}\\(\\s*['"]([\\w.]+)['"]`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]!);
}

function collectMissingKeys(): { key: string; locations: string[] }[] {
  const referenced = new Map<string, Set<string>>();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const text = stripComments(raw);
    const assigns = [...text.matchAll(ASSIGN_RE)];
    if (assigns.length === 0) continue;
    const rel = path.relative(SRC_ROOT, file);
    for (const [, varName, ns] of assigns) {
      for (const key of extractKeyUsages(text, varName!)) {
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

describe('extractKeyUsages — ㉥ 멤버접근(`obj.t(...)`)은 로컬 t() 호출로 오귀속되지 않는다 (#3149)', () => {
  it('바로 호출(`t(...)`)은 정상적으로 잡힌다', () => {
    expect(extractKeyUsages("t('title');", 't')).toEqual(['title']);
  });

  it('멤버접근(`acc.t(...)`)은 varName=t로 조회할 때 안 잡힌다', () => {
    expect(extractKeyUsages("acc.t('title');", 't')).toEqual([]);
  });

  it('한 파일에 로컬 t(...)와 멤버접근 acc.t(...)가 공존해도 로컬 호출만 잡힌다', () => {
    const content = "t('switcherMobileTriggerAria');\nacc.t('title');\nacc.t('signOutAll');";
    expect(extractKeyUsages(content, 't')).toEqual(['switcherMobileTriggerAria']);
  });

  it('식별자 끝에 우연히 걸리는 것도 여전히 안 잡힌다(기존 워드바운더리 보존 — get(\'x\')의 t(\'x\')류)', () => {
    expect(extractKeyUsages("get('title');", 't')).toEqual([]);
  });
});

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
