import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// story #3260 2차(유나 design 라이브 실측 FAIL, 2026-08-31) — 지원 위젯이 Support
// Gateway를 브라우저에서 직접 호출(BFF 프록시 없음, gateway-client.ts)하는데, CORS(story
// #3242/#3649·서버측 "누구를 받아줄지" 허용)를 열어도 이 앱 자체의 CSP connect-src("우리
// 문서가 어디로 나갈 수 있는지" 허용)가 별개 층이라 브라우저가 fetch 자체를 보내기도
// 전에 차단했다(콘솔 실측: "violates CSP directive: connect-src"). NEXT_PUBLIC_
// SUPPORT_GATEWAY_URL(cloudbuild.yaml·Dockerfile 배선, story #3260 1차)이 이미 진실원
// (dev만 실 URL·prod는 빈 문자열)이라 그대로 파생한다 — dev/prod origin을 여기 하드코딩
// 하지 않는다(그 값 자체가 두 번째 SSOT가 되는 함정 회피).
const _SUPPORT_GATEWAY_CSP_ORIGIN = (() => {
  const raw = process.env['NEXT_PUBLIC_SUPPORT_GATEWAY_URL'];
  if (!raw) return null; // 미설정(prod·위젯 미노출 빌드)이면 CSP도 그대로 안 연다.
  try {
    return new URL(raw).origin;
  } catch {
    return null; // 정직한 값 부재 취급 — CSP 문법을 깨느니 안 여는 쪽이 안전측.
  }
})();

const _CSP = [
  "default-src 'self'",
  // story #2510 — Toss 결제위젯 SDK(js.tosspayments.com)가 script-src에 없으면 카드
  // 인증창 자체가 CSP로 막힌다(라이브 실측 중 실물 확認 — 유닛테스트는 브라우저 CSP를
  // 실행하지 않아 이 클래스를 못 잡는다).
  // story #3918 — Cloudflare Zone이 Web Analytics beacon(static.cloudflareinsights.com)을
  // 자동 주입하는데 CSP가 막아 콘솔에러가 났다. 판정은 원래 "끄기"(GA4가 정본)였으나
  // 공유 CF API 토큰이 zone 스코프뿐이라 Web Analytics(계정 스코프 rum API) 자체를
  // 끌 권한이 없다(PO 실측, Authentication error) — 사용자 영향 0인 콘솔 오류 하나로
  // 선생님께 계정 권한 상신을 쌓지 않고 허용으로 닫는다(PO 결정).
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.tosspayments.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  // GCS 파일, Google/GitHub 아바타 이미지 + story #3532(PO 재대조 2026-09-06) —
  // 브랜드 킷 로고는 고객이 «자기 사이트»에 올린 임의 URL이다(우리 인프라가 아니다)
  // — exact-origin allowlist로는 애초에 못 맞힌다(GCS/아바타류 known-service와
  // 다른 클래스). https: 전체 허용 없이는 CSP가 멀쩡한 URL을 조용히 막고, onError가
  // 그걸 "죽은 링크"로 오판해 화면이 거짓말을 한다(#3532 PO REQUIRED — 페드루
  // 발견·유나 검토).
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // API 호출 (self = Next.js rewrites 경유, googleapis = Cloud KMS/AI, tosspayments = 결제
  // 위젯 SDK 자체 통신 — story #2510). Support Gateway origin은 위 상수 참고 — 브라우저가
  // 직접 호출하는 유일한 비-self API 오리진(다른 모든 데이터 fetch는 Next.js BFF 프록시
  // 경유라 'self'로 충분, 위젯만 예외).
  [
    // story #3918 — beacon 스크립트 자체(script-src)뿐 아니라 그게 쏘는 리포트 호출도
    // connect-src가 막는다(같은 콘솔 오류 클래스) — cloudflareinsights.com 추가.
    "connect-src 'self' https://*.googleapis.com https://*.tosspayments.com https://cloudflareinsights.com",
    _SUPPORT_GATEWAY_CSP_ORIGIN,
  ].filter(Boolean).join(' '),
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
  //
  // story #2809 — 2807 QA(카디르)가 같은 근본원인(frame-src)에 걸리는 잔존 경로 2곳을
  // 더 찾았다: docs YouTube/Figma embed(embed-node.tsx, 항상 www.youtube.com/embed·
  // www.figma.com/embed로 고정 재작성되는 known-service origin — GCS처럼 임의 콘텐츠를
  // 끼울 여지가 없어 exact-origin allowlist가 정당)와 채팅 html 첨부 미리보기(GCS 서명
  // URL을 그대로 썼던 것 — pptx/PDF와 동일하게 blob: 전환, 새 origin 개방 불요).
  "frame-src blob: https://www.youtube.com https://www.figma.com",
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

// story #3947(2026-09-16, 페드루 PO 판정) — apps/web/src/lib/public-app-host.ts의 런타임
// 가드(NODE_ENV=production인데 env 부재면 throw)는 그 함수가 실제로 호출될 때만(클라
// 렌더 시점) 걸린다 — create-organization-dialog.tsx/onboarding-form.tsx는 인증 뒤
// 화면이라 정적 프리렌더 대상이 아니라 `next build` 자체는 통과하고 브라우저에서만
// 늦게 터질 수 있었다. 이 모듈은 `next build`가 로드하자마자(설정 파싱 시점) 실행되므로
// 여기서 한 번 더 검사하면 **빌드 자체가** 즉시 RED — 조용한 fallback이 CI/배포까지
// 새어나가는 것을 원천 차단한다(`next dev`는 NODE_ENV=development라 안 걸림).
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_APP_URL?.trim()) {
  throw new Error(
    'NEXT_PUBLIC_APP_URL이 배포 빌드에 배선되지 않았다(story #3947) — cloudbuild.yaml의 ' +
      'build-frontend 스텝 --build-arg / Dockerfile ARG·ENV를 확認하라.'
  );
}

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
      // story #3915 — 이 세 은퇴 주소는 전에 page.tsx 안에서 next/navigation의 redirect()를
      // 직접 호출했는데, 셋 다 조상 디렉토리에 loading.tsx(스트리밍 Suspense 경계)가 있어
      // React 렌더 단계까지 redirect()가 밀려 들어갔다 — 그 경계가 응답 헤더를 200으로
      // 커밋한 뒤에야 redirect()가 실행되면 Next가 깨끗한 3xx를 못 내고 "server rendering
      // errored→client 전환" 열화 경로(meta refresh + NEXT_REDIRECT digest)를 타는데, 그
      // 경로가 Next.js 자체 내부 싱글턴 Router(app-router.js의 mpaNavigation 분기 — 그
      // 소스 자신의 주석이 "violates the rules of hooks"라고 자인)의 훅 호출 수를 렌더마다
      // 다르게 만들어 React 오류 코드 310("Rendered more hooks than during the previous
      // render")을 던졌다(curl 실측: recruiter·hitl·membersAgentsLegacy 셋 다 200+메타
      // 리프레시, 같은 loading.tsx 경계 밖의 다른 은퇴 주소는 깨끗한 307). 우리 애플리케이션
      // 코드엔 조건부 훅이 없어 "훅 앞에 무조건 호출" 처방을 적용할 자리가 없다 — 대신
      // redirect를 이 라우팅 단계로 옮기면 React 렌더/스트리밍 진입 자체가 사라져 그 경합이
      // 원천적으로 발생할 수 없다(위 board/agents 선례와 동일 메커니즘, 새 패턴 아님).
      // organization/workforce/loading.tsx 경계: recruiter(구 채용관, story d63d3f73)·
      // hitl(구 HITL 승인 대기, story #2054 AC4). settings/loading.tsx 경계:
      // members/agents/[id](구 에이전트 상세, story d63d3f73 — :id 캡처 재사용은 위
      // /agents/:path* 선례와 동형).
      { source: '/organization/workforce/recruiter', destination: '/organization/workforce?tab=recruit', permanent: true },
      { source: '/organization/workforce/hitl', destination: '/inbox', permanent: true },
      { source: '/settings/members/agents/:id', destination: '/organization/workforce/:id', permanent: true },
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
