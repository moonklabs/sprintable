import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'ko'];
const DEFAULT_LOCALE = 'en';

// story #3778 CHANGES(유나 design:changes 2026-09-10 — 카디르 큐 전 발견) — export해
// BFF(retro-sessions/[id]/export/route.ts)가 이 함수 하나로 로케일을 푼다. 전엔 그
// 라우트가 `locale` 쿠키만 직접 읽어(헤더 폴백 없이) — 쿠키를 한 번도 세팅 안 한
// 신규 사용자(로케일 스위처를 안 건드린 사람, 세팅 자리는 locale-switcher.tsx 단
// 한 곳)는 화면이 실제로 보여주는 언어(Accept-Language로 en 결정)와 내보내기 문서
// 언어(쿠키 부재→헤더 미전달→BE 자체 기본값)가 갈렸다 — 해석 로직이 두 곳(화면
// vs 이 BFF)에 따로 있으면 반드시 이렇게 벌어진다는 하우스 교훈 그대로 재현. 이제
// 해석은 이 함수 하나뿐 — route.ts는 결과 문자열만 그대로 forward.
export async function getLocale(): Promise<string> {
  // 1. 쿠키 확인
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get('locale')?.value;
  if (cookieLocale && SUPPORTED_LOCALES.includes(cookieLocale)) return cookieLocale;

  // 2. Accept-Language 헤더
  const headerStore = await headers();
  const acceptLang = headerStore.get('accept-language') ?? '';
  for (const locale of SUPPORTED_LOCALES) {
    if (acceptLang.includes(locale)) return locale;
  }

  return DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const locale = await getLocale();

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
