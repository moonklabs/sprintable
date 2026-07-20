import type { Metadata, Viewport } from "next";
import { Geist_Mono, Source_Serif_4 } from "next/font/google";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { GoogleAnalytics } from '@/components/google-analytics';
import { resolveAppUrl } from '@/services/app-url';
import "./globals.css";

const SITE_TITLE = "Sprintable — The PM tool where agents are teammates";
const SITE_DESCRIPTION = "AI-powered sprint management. Kanban, memos, standups, retros, MCP server — with AI agents as first-class team members.";

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

// story #2022: 링크 공유 미리보기(OG) 신설 — 이전엔 metadata.openGraph 자체가 없어 공유 시
// 브랜드가 아예 안 떴다. 로케일별(ko/en) 이미지를 generateMetadata로 분기(정적 export로는
// 요청 로케일을 못 읽는다). og:image 하나로 twitter card도 겸한다(twitter.card=summary_large_image,
// 별도 이미지 미지정 시 OG 폴백 — nextjs metadata 컨벤션).
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const ogImage = locale === 'en'
    ? { url: '/og/opengraph-en.png', alt: 'Sprintable' }
    : { url: '/og/opengraph-ko.png', alt: 'Sprintable' };

  return {
    metadataBase: new URL(resolveAppUrl(undefined)),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    openGraph: {
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      locale: locale === 'en' ? 'en_US' : 'ko_KR',
      type: 'website',
      images: [{ ...ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: [ogImage.url],
    },
  };
}

export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${geistMono.variable} ${sourceSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* story #2026: 라틴+코어만 preload — 확장(907.8KB)까지 걸면 unicode-range 판정을
            건너뛰고 항상 받아버려 §3-4의 겹침-우선권 구성 자체가 무력화된다(유나 지적). */}
        <link rel="preload" href="/fonts/pretendard-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/pretendard-korean-core.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body className="h-full">
        <GoogleAnalytics />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <NextIntlClientProvider locale={locale} messages={messages}>
            {children}
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
