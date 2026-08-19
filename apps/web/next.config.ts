import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const _CSP = [
  "default-src 'self'",
  // story #2510 — Toss 결제위젯 SDK(js.tosspayments.com)가 script-src에 없으면 카드
  // 인증창 자체가 CSP로 막힌다(라이브 실측 중 실물 확認 — 유닛테스트는 브라우저 CSP를
  // 실행하지 않아 이 클래스를 못 잡는다).
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.tosspayments.com",
  "style-src 'self' 'unsafe-inline'",
  // GCS 파일, Google/GitHub 아바타 이미지
  "img-src 'self' data: blob: https://storage.googleapis.com https://*.googleusercontent.com https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  // API 호출 (self = Next.js rewrites 경유, googleapis = Cloud KMS/AI, tosspayments = 결제
  // 위젯 SDK 자체 통신 — story #2510)
  "connect-src 'self' https://*.googleapis.com https://*.tosspayments.com",
  // story #2083 — 채팅 첨부 영상(GCS 서명 URL)이 <video>로 로드될 때 media-src에
  // storage.googleapis.com이 없어 CSP가 통째로 차단하고 있었다(콘솔 실측). img-src에는
  // 이미 같은 호스트가 허용돼 있다(story #2050, 서명 URL·노출 축 동일) — 새 origin을
  // 여는 것이 아니라 media-src를 img-src와 같은 경계로 맞추는 것이다.
  "media-src 'self' blob: https://storage.googleapis.com",
  // story #2807 — PDF/pptx 인앱 미리보기가 GCS 서명 URL을 곧바로 iframe src에 넣어
  // frame-src 'none'에 원천 차단됐다(선생님 실측 ERR_BLOCKED_BY_CSP). storage.googleapis.com
  // 같은 외부 호스트를 통째로 열면 임의 GCS 콘텐츠를 끼우는 피싱 표면이 생긴다(toss-checkout
  // 선례와 동일 판단) — 대신 FE가 fetch→Blob→객체 URL로 직접 받아 그 blob: URL만 iframe에
  // 넣는다. blob:은 그 탭이 방금 만든 콘텐츠만 가리키므로 외부 호스트 개방보다 훨씬 좁다.
  "frame-src blob:",
  "object-src 'none'",
  "base-uri 'self'",
  // OAuth 리다이렉트 대상
  "form-action 'self' https://accounts.google.com https://github.com",
].join('; ');

const _SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: _CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  // Allow dev server access from non-localhost origins (e.g. Tailscale, LAN)
  // Set NEXT_DEV_ALLOWED_ORIGINS=host1,host2 in .env.local to enable
  allowedDevOrigins: process.env['NEXT_DEV_ALLOWED_ORIGINS']?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
  output: 'standalone',
  // story #2050: 채팅 첨부 이미지가 next/image로 GCS 서명 URL을 리사이즈 요청할 수 있도록 허용.
  // src는 항상 우리 /api/attachments/sign 응답에서만 오므로(사용자 입력 직접 미반영) 호스트
  // 단위 허용으로 충분 — CSP img-src에도 이미 동일 호스트가 허용돼 있다.
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'storage.googleapis.com' }],
  },
  // Bundle workspace packages from source (resolved via tsconfig paths) rather than
  // externalizing their built dist. The Cloud Build context uploads the host's
  // packages/*/dist (no .gcloudignore) and `next build --webpack` never rebuilds it,
  // so without this the server bundle consumed a STALE dist — e.g. an old
  // updateDocSchema that silently stripped slug/slug_locked (broke #4dd399c6 live).
  // Forcing src-transpile makes src the single source of truth for every consumer.
  transpilePackages: ['@sprintable/shared', '@sprintable/core-storage', '@sprintable/storage-api'],
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/docs/design-tokens': ['./src/app/globals.css'],
  },
  devIndicators: {
    position: 'bottom-right',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: _SECURITY_HEADERS,
      },
    ];
  },
  async redirects() {
    return [
      { source: '/memos', destination: '/inbox', permanent: true },
      { source: '/memos/:path*', destination: '/inbox', permanent: true },
      // 문서 단일화(2026-08-10 선생님 지시): 에이전트 공개 문서(llms.txt·llms-full.txt·
      // connect-guide.txt·onboarding-guide.txt)의 유일 canonical 은 «앱 안»(apps/web/public)이다.
      // 랜딩(sprintable.ai)은 의도적으로 분리된 별도 레포라, 이전의 app→랜딩 301 을 제거해
      // app 이 자기 public 파일을 직접(canonical) 서빙한다 — 랜딩의 옛 사본으로 넘기지 않는다.
      // (제거 前엔 llms.txt/llms-full.txt 만 랜딩으로 301 하던 반쪽 통일이라 오히려 갈렸다.)
      // story c4980e70(조직 1급화 IA·doc org-1st-class-surface-ia-design-b §1): 에이전트 관리가
      // /agents → /organization/workforce(조직=1급 구역)로 승격. 서브라우트 전체(상세·runs·recruiter 등) 보존.
      { source: '/agents', destination: '/organization/workforce', permanent: true },
      { source: '/agents/:path*', destination: '/organization/workforce/:path*', permanent: true },
      // org-members 탭(settings)도 같은 승격 — 조직 구성원 관리의 새 1급 홈은 /organization/members.
      {
        source: '/settings',
        has: [{ type: 'query', key: 'tab', value: 'org-members' }],
        destination: '/organization/members',
        permanent: true,
      },
      // story #2224(선생님 정정 2026-07-30) — "보드+현황판 통합"의 실제 자리는 /flow. board는
      // 살아 있는 기능(KanbanBoard)이라 라우트만 흡수 — permanent:false(되돌리기 쉬운 쪽, IA가
      // 갓 확定돼 하루 안에도 두 번 뒤집힌 전례가 있다). `?story=`/`?task_id=` 등 미매치 쿼리는
      // Next.js redirects()가 destination에 자동 병합(문서화된 동작, dev 빌드로 curl 실측 확認
      // 완료 — 값으로 닫음).
      { source: '/:ws/:proj/board', destination: '/:ws/:proj/flow?view=list', permanent: false },
    ];
  },
  async rewrites() {
    const fastapiUrl = process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000';
    return [
      {
        source: '/api/v2/:path*',
        destination: `${fastapiUrl}/api/v2/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
