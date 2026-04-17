import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

const SUPPORTED_LOCALES = ['en', 'ko'];
const DEFAULT_LOCALE = 'en';

async function getLocale(): Promise<string> {
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
