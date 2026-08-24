import type { Metadata, Viewport } from "next";
import { Geist_Mono, Source_Serif_4 } from "next/font/google";
import localFont from "next/font/local";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { GoogleAnalytics } from '@/components/google-analytics';
import { resolveAppUrl } from '@/services/app-url';
import "./globals.css";

// story #2745(선생님 지적 2026-08-18, PR#3202 리뷰 유나 확認) — "PM tool"/"AI-powered sprint
// management"는 옛 포지셔닝(우리는 PM 툴이 아니다). login.subtitle과 같은 철학 정본(개인이
// 아니라 조직·열린 루프를 닫는다·조직을 위한 워크스페이스 OS)에서 도출 — title은 sprintable-landing
// 정본 <title>과 동일(이미 선생님 승인).
const SITE_TITLE = "Sprintable — Ship with AI agents";
const SITE_DESCRIPTION = "The organization OS that closes open loops. Kanban, memos, standups, retros, MCP server — with AI agents as first-class team members.";

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

// story #2974 §4(PR-D1) — Display 헤딩 전용 한글 세리프. OFL 1.1·서브셋(KS X 1001 상용
// 2350자+Latin+숫자+구두점)·wght=820 단일 인스턴스(가변 축 통째로 안 실음, §4 확定).
// next/font/local이 만드는 CSS 변수를 globals.css `--font-display`(§1)가 그대로
// 참조한다 — 폴백은 generic `serif`(서브셋 밖 벽자가 와도 시스템 세리프로 떨어져 세리프
// 헤딩 안에 산세리프 글자가 안 섞인다). 라이선스: public/fonts/NotoSerifKR-OFL.txt 동봉.
const notoSerifKR = localFont({
  src: "../../public/fonts/NotoSerifKR-display.woff2",
  variable: "--font-serif-kr",
  weight: "820",
  style: "normal",
  display: "swap",
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
      className={`${geistMono.variable} ${sourceSerif.variable} ${notoSerifKR.variable} h-full antialiased`}
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
