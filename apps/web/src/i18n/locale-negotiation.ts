// story #4289 — 화면 언어를 정하는 규칙 하나. 쿠키 `locale` → Accept-Language(헤더 순서 + q값) → 기본값 'en'.
//
// 전에는 `i18n/request.ts`(RSC · next-intl)와 `proxy.ts`(미들웨어 · connect-guide 정적 문서)가 같은 규칙을 각자 들고
// 있었고, 둘 다 지원 목록 순서(en 먼저)로 `acceptLang.includes(locale)` 부분 문자열 대조를 했다. 그래서 한국어를
// 첫째로 둔 흔한 크롬 값(`ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7`)이 첫 화면을 영어로 받았다(PO 실측 2026-09-25 · dev-app
// GET /login → lang="en" · 한국어 0자). q값 · 순서를 무시하고, 다른 태그 속 글자(`xen`)에도 걸렸다.
//
// 이 모듈은 next/headers를 안 부른다 — 미들웨어(동기 NextRequest)와 RSC(비동기 headers()) 양쪽이 값만 꺼내 넘긴다.
// 새로 언어를 정하는 자리는 여기 resolveLocale 하나만 읽는다(사본 0 — locale-negotiation.guard.test.ts가 지킨다).

export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

interface AcceptEntry {
  primary: string;
  q: number;
  index: number;
}

// `ko-KR,ko;q=0.9,en-US;q=0.8` → [{ primary: 'ko', q: 1 }, { primary: 'ko', q: 0.9 }, { primary: 'en', q: 0.8 }].
// 태그는 주 언어(첫 `-` 앞)만 소문자로 본다 — 부분 문자열 대조 금지. q가 없으면 1, 형식이 깨졌거나 0이면 뺀다(RFC 9110 §12.5.4).
function parseAcceptLanguage(header: string): AcceptEntry[] {
  const out: AcceptEntry[] = [];
  header.split(',').forEach((part, index) => {
    const [rawTag, ...params] = part.split(';');
    const primary = (rawTag ?? '').trim().toLowerCase().split('-')[0] ?? '';
    if (!primary) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9](?:\.[0-9]{0,3})?)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
      else if (/^\s*q\s*=/i.test(p)) q = NaN;
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) return;
    out.push({ primary, q, index });
  });
  // q 높은 순, 같으면 헤더에 먼저 나온 순.
  return out.sort((a, b) => b.q - a.q || a.index - b.index);
}

// 지원 언어 중 사용자가 가장 선호하는 것. `*`(아무거나)는 기본값. 맞는 게 없으면 null.
export function pickFromAcceptLanguage(header: string | null | undefined): SupportedLocale | null {
  if (!header) return null;
  for (const e of parseAcceptLanguage(header)) {
    if (e.primary === '*') return DEFAULT_LOCALE;
    if (isSupportedLocale(e.primary)) return e.primary;
  }
  return null;
}

export function resolveLocale(input: { cookie?: string | null; acceptLanguage?: string | null }): SupportedLocale {
  if (isSupportedLocale(input.cookie)) return input.cookie;
  return pickFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}
