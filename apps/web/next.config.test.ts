// story #2083 회귀가드 — 채팅 첨부 영상(GCS 서명 URL)이 <video>로 로드될 때 CSP의
// media-src에 storage.googleapis.com이 없으면 브라우저가 로드를 통째로 차단한다(콘솔
// 실측: "violates ... media-src 'self' blob:"). 그 실패가 화면엔 "지원하지 않는 형식"으로
// 잘못 보인다 — 코덱/MIME 문제가 아니라 CSP였다. img-src에는 같은 호스트가 이미 있다
// (story #2050) — media-src만 빠져 있었던 것을 여기서 고정한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
