#!/usr/bin/env node
/**
 * story #3156 — i18n 키 추출 파서 공유 모듈. `scripts/check-i18n-keys.js`(CI, plain node)와
 * `apps/web/src/lib/i18n-key-coverage.test.ts`(vitest)가 같은 판정("코드가 쓰는 i18n 키가
 * messages에 있나")을 서로 다른 독립 regex 구현으로 수행해 왔다 — #3149(PR#3558)에서 실증:
 * 멤버접근 오귀속 결함(`acc.t()`를 로컬 `t`로 셈)을 한쪽만 고치자 다른 쪽이 같은 오탐으로
 * CI를 계속 붉혔다. 이 파일이 그 파서를 한 곳으로 합친다 — 두 소비처가 여기서 import한다.
 *
 * plain CJS인 이유 — `check-i18n-keys.js`가 `node scripts/check-i18n-keys.js`로 직접 실행되고
 * (tsx/바벨 등 로더 없음, package.json `verify:i18n-keys`), apps/web은 `allowJs`+
 * `moduleResolution: bundler`라 vitest/tsc 양쪽에서 이 파일을 그대로 require/import할 수
 * 있다 — TS로 옮기면 CI 스크립트 쪽이 실행 전 컴파일 스텝을 새로 필요로 하게 된다.
 */

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, p));
    } else {
      out[p] = v;
    }
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// story #3023(카디르 QA #3445 근본추적) — 정규식 리터럴 안의 백틱을 아래 backtick 분기가
// 문자열 델리미터로 오인하면, 짝이 안 맞는(홀수 개) 백틱을 담은 정규식(예:
// `INLINE_CODE_SPAN_RE = /`[^`\n]*`/g`처럼 백틱 자체를 매칭하는 패턴)이 그 뒤 남은 파일
// 전체를 "닫히지 않은 문자열 안"으로 착각시켜, 그 이후의 진짜 `//` 주석이 전부 인식을 놓친다.
// '/' 직전의 마지막 유의미 문자가 이 목록에 있을 때만(정규식 리터럴이 실제로 오는 흔한
// 문맥 — `= /../`, `(/../`, `, /../` 등) 정규식으로 판별해 안쪽을 통째로 건너뛴다.
const REGEX_LITERAL_CONTEXT_CHARS = new Set(['=', '(', ',', ':', ';', '!', '&', '|', '?', '[']);

function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let lastSig = ''; // 마지막으로 출력한 공백 아닌 문자(정규식 vs 나눗셈 판별용).
  const emit = (ch) => {
    out += ch;
    if (!/\s/.test(ch)) lastSig = ch;
  };
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && c2 !== '/' && c2 !== '*' && REGEX_LITERAL_CONTEXT_CHARS.has(lastSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') { inClass = true; j++; continue; }
        if (source[j] === ']') { inClass = false; j++; continue; }
        if (source[j] === '/' && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(source[j])) j++; // 플래그(g/i/m/s/u/y 등) 소비.
        for (let k = i; k < j; k++) emit(source[k]);
        i = j;
        continue;
      }
      // 줄 끝까지 닫는 '/'를 못 찾으면 정규식이 아니었다(오판) — 아래 일반 처리로 폴백.
    }
    if (c === '"' || c === "'") {
      const quote = c;
      emit(c); i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { emit(source[i]); i++; if (i < n) { emit(source[i]); i++; } continue; }
        emit(source[i]); i++;
      }
      if (i < n) { emit(source[i]); i++; }
      continue;
    }
    if (c === '`') {
      emit(c); i++;
      let depth = 0;
      while (i < n) {
        if (source[i] === '\\') { emit(source[i]); i++; if (i < n) { emit(source[i]); i++; } continue; }
        if (source[i] === '`' && depth === 0) { emit(source[i]); i++; break; }
        if (source[i] === '$' && source[i + 1] === '{') { depth++; emit(source[i]); emit(source[i + 1]); i += 2; continue; }
        if (source[i] === '}' && depth > 0) { depth--; emit(source[i]); i++; continue; }
        emit(source[i]); i++;
      }
      continue;
    }
    emit(c); i++;
  }
  return out;
}

// 훅이 바인딩되는 실제 로컬 변수명을 파일마다 잡는다(하드코딩 `t` 가정을 버린다) — 서버
// `getTranslations()`도 실측상 useTranslations와 동형 인자(단순 문자열 네임스페이스)라 같이 잡는다.
const HOOK_BIND_RE = /const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([\w.]+)['"]/g;

/**
 * story #3149(카디르 QA 실측·미르코 근본추적, PR#3558) — 워드바운더리 `(?<![\w$])varName\(`가
 * 멤버 접근(`acc.t('title')`)의 `.t(`도 매치했다. `.`은 `\w`도 `$`도 아니라 룩비하인드를
 * 통과 — 파일이 `const t = useTranslations('nav')`를 갖고 *동시에* 다른 객체(커스텀 훅이
 * 반환한 `{ t, ... }`)의 `.t(...)`도 부르면, 후자가 전자(`nav`)로 오귀속돼 「missing」 거짓
 * 양성을 낸다. 룩비하인드에 `.`을 추가해 「바로 앞이 단어문자·`$`·`.` 중 어느 것도 아닐
 * 때만」 매치하도록 좁힌다 — 로컬 `t()` 직접 호출(정상 케이스)은 앞이 공백·`(`·`{` 등이라
 * 영향 없고, 멤버 접근(`xxx.t(...)`)만 제외된다.
 */
function extractKeyUsages(content, varName) {
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(varName)}\\(\\s*['"]([\\w.]+)['"]`, 'g');
  return [...content.matchAll(re)].map((m) => m[1]);
}

/** 파일 하나(주석 제거 완료 상태)에서 훅 바인딩(varName→namespace) 전부를 Map으로. */
function extractHookBindings(content) {
  const map = new Map();
  for (const m of content.matchAll(HOOK_BIND_RE)) {
    map.set(m[1], m[2]);
  }
  return map;
}

module.exports = {
  flatten,
  escapeRegExp,
  stripComments,
  extractKeyUsages,
  extractHookBindings,
  HOOK_BIND_RE,
};
