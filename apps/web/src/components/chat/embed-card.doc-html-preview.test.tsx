// @vitest-environment jsdom
//
// story #3776ccfe(FE·결재 카드, 선생님 실사용 발견) — doc 미리보기(EntityPreviewModal→
// renderEntityDetail doc 분기)가 content_format을 안 보고 항상 MdBody(마크다운 전용)에
// content를 먹였다. content_format='html'인 doc은 태그가 렌더 안 되고 이스케이프 텍스트로
// 그대로 찍혔다(선생님이 doc ea94dac4에서 실제로 본 그 증상) — 이 회귀가드가 그 결함을 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EntityPreviewModal } from './embed-card';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubDocFetch(content: string, contentFormat: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/docs/preview')) {
      return {
        ok: true,
        json: async () => ({ data: { slug: 'd-1', projectId: 'p-1', orgSlug: 'org', projectSlug: 'proj' } }),
      };
    }
    if (url.includes('/api/docs?')) {
      return {
        ok: true,
        json: async () => ({ data: { content, content_format: contentFormat } }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

async function mount(content: string, contentFormat: string) {
  stubDocFetch(content, contentFormat);
  await act(async () => {
    root.render(
      <EntityPreviewModal
        entityType="doc" entityId="d-1" title="문서" status={null} href={null}
        onClose={() => {}} embedded
      />,
    );
  });
  await flush();
}

describe('EntityPreviewModal doc 미리보기 — content_format 분기(story #3776ccfe)', () => {
  it('content_format=html이면 태그가 텍스트로 노출되지 않고 실제 HTML로 렌더된다', async () => {
    await mount('<h3>제목</h3><p>본문 <b>강조</b></p>', 'html');
    // 태그 원문 노출 0 — 이스케이프 텍스트로 "<h3>" 같은 문자열이 그대로 안 보인다.
    expect(container.textContent).not.toContain('<h3>');
    expect(container.textContent).not.toContain('<p>');
    // 실제로 HTML 엘리먼트로 렌더됐다(sanitize 통과 후 dangerouslySetInnerHTML).
    expect(container.querySelector('h3')?.textContent).toBe('제목');
    expect(container.querySelector('b')?.textContent).toBe('강조');
  });

  it('content_format=html의 위험 태그(script)는 DOMPurify sanitize로 제거된다(XSS 회귀가드)', async () => {
    await mount('<p>안전</p><script>alert(1)</script><img src=x onerror="alert(2)">', 'html');
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('content_format=markdown(기본값)은 기존 MdBody 그대로 렌더된다(회귀 0)', async () => {
    await mount('# 제목\n\n본문 **강조**', 'markdown');
    expect(container.querySelector('h1')?.textContent).toBe('제목');
    expect(container.querySelector('strong')?.textContent).toBe('강조');
  });
});
