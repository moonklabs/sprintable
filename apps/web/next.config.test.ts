// story #2083 회귀가드 — 채팅 첨부 영상(GCS 서명 URL)이 <video>로 로드될 때 CSP의
// media-src에 storage.googleapis.com이 없으면 브라우저가 로드를 통째로 차단한다(콘솔
// 실측: "violates ... media-src 'self' blob:"). 그 실패가 화면엔 "지원하지 않는 형식"으로
// 잘못 보인다 — 코덱/MIME 문제가 아니라 CSP였다. img-src에는 같은 호스트가 이미 있다
// (story #2050) — media-src만 빠져 있었던 것을 여기서 고정한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG_SOURCE = readFileSync(path.resolve(__dirname, 'next.config.ts'), 'utf-8');

function extractDirective(name: string): string {
  const match = new RegExp(`"${name} ([^"]*)"`).exec(CONFIG_SOURCE);
  if (!match) throw new Error(`${name} directive not found in next.config.ts`);
  return match[1]!;
}

describe('CSP media-src (story #2083 regression guard)', () => {
  it('allows storage.googleapis.com so chat video attachments can load', () => {
    expect(extractDirective('media-src')).toContain('https://storage.googleapis.com');
  });

  it('still allows blob: (download-then-play path relies on it)', () => {
    expect(extractDirective('media-src')).toContain('blob:');
  });

  it('img-src and media-src agree on the GCS origin (same signed-URL exposure surface, story #2050)', () => {
    expect(extractDirective('img-src')).toContain('https://storage.googleapis.com');
    expect(extractDirective('media-src')).toContain('https://storage.googleapis.com');
  });
});

// story #2809 회귀가드 — 2807(PDF/pptx blob 전환)이 frame-src를 'none'→blob:로 좁혔지만,
// 같은 근본원인에 걸리는 다른 iframe 사용처(docs YouTube/Figma embed, 채팅 html 첨부
// 미리보기)는 그대로 남아 있었다(카디르 QA 발견). exact-origin allowlist가 정당한
// known-service(youtube/figma, embed-node.tsx가 항상 이 두 origin으로만 재작성)와
// blob: 전환(html 첨부, PdfBody와 동형)을 여기서 못박는다 — storage.googleapis.com 같은
// 외부 호스트 통째 개방은 여전히 금지(피싱 표면).
describe('CSP frame-src (story #2809 regression guard)', () => {
  it('allows blob: (pdf/pptx/html preview 전부 fetch→Blob→객체URL 경유, story #2807/#2809)', () => {
    expect(extractDirective('frame-src')).toContain('blob:');
  });

  it('allows the exact YouTube/Figma embed origins docs embed-node.tsx always rewrites to', () => {
    expect(extractDirective('frame-src')).toContain('https://www.youtube.com');
    expect(extractDirective('frame-src')).toContain('https://www.figma.com');
  });

  it('does not blanket-open storage.googleapis.com (GCS는 임의 콘텐츠를 끼울 수 있어 exact-origin allowlist 부적합 — toss-checkout 선례)', () => {
    expect(extractDirective('frame-src')).not.toContain('storage.googleapis.com');
  });
});

// story #3260 2차(유나 design 라이브 실측 FAIL, 2026-08-31) — CORS(서버측 허용)는 이미
// 열려있었는데 이 앱 자체의 CSP connect-src(문서측 outbound 제한)가 별개 층이라 위젯의
// 브라우저 직접 fetch가 fetch를 보내기도 전에 막혔다. 위 파일의 static-source-regex
// 방식(extractDirective)은 connect-src가 이제 env 기반 계산식이라 못 잡는다 — 실제로
// 다른 env로 모듈을 재평가해 결과 헤더값을 대조한다.
describe('CSP connect-src — Support Gateway origin (story #3260 2차 회귀가드)', () => {
  const ENV_KEY = 'NEXT_PUBLIC_SUPPORT_GATEWAY_URL';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  async function cspHeaderValue(): Promise<string> {
    vi.resetModules();
    const mod = await import('./next.config');
    const config = mod.default as { headers?: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
    const groups = await config.headers!();
    return groups[0]!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
  }

  it('NEXT_PUBLIC_SUPPORT_GATEWAY_URL이 설정되면 그 origin이 connect-src에 실린다(위젯 fetch가 CSP에 막히던 실사고 회귀가드)', async () => {
    process.env[ENV_KEY] = 'https://support-gateway-dev-57iommnikq-du.a.run.app';
    const csp = await cspHeaderValue();
    expect(csp).toContain('https://support-gateway-dev-57iommnikq-du.a.run.app');
  });

  it('미설정(prod류 — 위젯 자체가 안 뜨는 빌드)이면 하드코딩 origin 없이 connect-src가 원래 값 그대로다', async () => {
    delete process.env[ENV_KEY];
    const csp = await cspHeaderValue();
    expect(csp).not.toContain('run.app');
    expect(csp).toContain("connect-src 'self' https://*.googleapis.com https://*.tosspayments.com");
  });

  it('URL로 파싱 안 되는 값이면 CSP 문법을 깨지 않고 안전하게 무시한다(정직한 부재 취급)', async () => {
    process.env[ENV_KEY] = 'not-a-valid-url';
    const csp = await cspHeaderValue();
    expect(csp).toContain("connect-src 'self' https://*.googleapis.com https://*.tosspayments.com");
    expect(csp).not.toContain('not-a-valid-url');
  });
});
