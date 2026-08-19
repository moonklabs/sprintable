import { describe, it, expect } from 'vitest';
import { detectEmbedService } from './embed-node';

// story #2809(페드루군 AC 지적, PR#3237 CSP frame-src exact-origin allowlist 전제) —
// CSP가 정확히 https://www.youtube.com/https://www.figma.com만 허용하므로, 이 함수가
// 반환하는 embedUrl은 입력 형태와 무관하게 *항상* 그 canonical origin이어야 한다. 구
// 코드는 이미 /embed/ 경로인 youtube URL을 원본 그대로 통과시켜(www 없는 호스트·서브도메인
// 등) CSP에 막혀 조용히 백지가 되는 경로가 있었다.

describe('detectEmbedService — YouTube (story #2809)', () => {
  it('watch URL(v= 쿼리)을 www.youtube.com/embed/{id}로 재작성한다', () => {
    expect(detectEmbedService('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      type: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('youtu.be 단축 URL도 재작성한다', () => {
    expect(detectEmbedService('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      type: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('이미 www.youtube.com/embed/ 경로인 URL도 canonical origin으로 재작성한다(원본 그대로 통과 금지)', () => {
    expect(detectEmbedService('https://www.youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      type: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('www 없는 youtube.com/embed/ URL도 재작성한다(구 코드가 원본 그대로 통과시켜 CSP에 막히던 경로)', () => {
    expect(detectEmbedService('https://youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      type: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('music.youtube.com 서브도메인 embed URL도 재작성한다', () => {
    expect(detectEmbedService('https://music.youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      type: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('"notyoutube.com" 같은 부분일치 도메인은 youtube로 오판하지 않는다(hostname.includes 느슨매치 회귀 가드)', () => {
    const result = detectEmbedService('https://notyoutube.com/embed/dQw4w9WgXcQ');
    expect(result.type).toBe('fallback');
  });
});

describe('detectEmbedService — Figma', () => {
  it('file/design/proto 경로를 embed URL로 감싼다', () => {
    const result = detectEmbedService('https://www.figma.com/file/abc123/My-Design');
    expect(result.type).toBe('figma');
    expect(result.embedUrl).toBe(
      'https://www.figma.com/embed?embed_host=share&url=' + encodeURIComponent('https://www.figma.com/file/abc123/My-Design'),
    );
  });

  it('"notfigma.com" 같은 부분일치 도메인은 figma로 오판하지 않는다', () => {
    const result = detectEmbedService('https://notfigma.com/file/abc123/My-Design');
    expect(result.type).toBe('fallback');
  });
});

describe('detectEmbedService — fallback', () => {
  it('인식 못 하는 URL은 fallback으로 원본을 그대로 낸다', () => {
    expect(detectEmbedService('https://example.com/some-page')).toEqual({
      type: 'fallback', embedUrl: 'https://example.com/some-page',
    });
  });

  it('파싱 불가 URL도 크래시 없이 fallback으로 떨어진다', () => {
    expect(detectEmbedService('not a url')).toEqual({ type: 'fallback', embedUrl: 'not a url' });
  });
});
