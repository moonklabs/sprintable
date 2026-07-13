import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_EDITABLE_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ArtifactViewer (SSR snapshot)', () => {
  it('renders the anchor badge for the artifact anchor version, not the currently-selected one', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    // MOCK_ARTIFACT.anchor_version = 3 — badge shows "정본 v3" regardless of current_version=4 being selected by default.
    expect(markup).toContain('정본 v3');
  });

  it('fully locks down the html stage sandbox (no allow-scripts, no allow-same-origin — 유나 디자인 가디언 보안 지적 반영)', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).toContain('sandbox=""');
    expect(markup).not.toContain('allow-scripts');
    expect(markup).not.toContain('allow-same-origin');
  });

  it('omits the anchor badge entirely when the artifact has no anchor version yet (초안 중립·낙인 금지)', () => {
    const draftArtifact = { ...MOCK_ARTIFACT, anchor_version: null };
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={draftArtifact} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).not.toContain('정본 v');
  });

  it('renders every thread as a comment card when threads is passed (C2 — 지금까지 핀/카운트 배지만 있고 실제 카드 목록이 없던 갭)', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} />),
    );
    for (const thread of MOCK_THREADS) {
      expect(markup).toContain(thread.comments[0]!.body);
    }
  });

  it('renders no comment panel when threads is omitted or empty', () => {
    const markupNoThreads = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    const markupEmptyThreads = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={[]} />),
    );
    expect(markupNoThreads).not.toContain(MOCK_THREADS[0]!.comments[0]!.body);
    expect(markupEmptyThreads).not.toContain(MOCK_THREADS[0]!.comments[0]!.body);
  });

  it('shows a propose-as-anchor button on a non-anchor version when onProposeCanonical is provided (C4-S8 §1 — 제안만, 승인은 GateInbox)', () => {
    const markup = renderToStaticMarkup(
      // MOCK_ARTIFACT.current_version=4 is selected by default, anchor_version=3 — non-anchor.
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onProposeCanonical={() => {}} />),
    );
    expect(markup).toContain('정본으로 제안');
  });

  it('shows a pending badge instead of the propose button when the selected version already has a pending proposal', () => {
    const markup = renderToStaticMarkup(
      wrap(
        <ArtifactViewer
          artifact={MOCK_ARTIFACT}
          versions={MOCK_VERSIONS}
          memberMap={MOCK_MEMBERS}
          onProposeCanonical={() => {}}
          pendingCanonicalizeVersion={MOCK_ARTIFACT.current_version}
        />,
      ),
    );
    expect(markup).toContain('정본 제안 대기 중');
    expect(markup).not.toContain('정본으로 제안');
  });

  it('omits both the propose button and pending badge without onProposeCanonical (읽기전용 폴백)', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).not.toContain('정본으로 제안');
    expect(markup).not.toContain('정본 제안 대기 중');
  });

  describe('story 1948d19d — 캔버스 뷰포트 재설계(v1~v2.1 스크롤/오버레이 모델 전면 폐기)', () => {
    it('renders the transform-canvas viewport for html — no more fixed 1200px scroll container', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(markup).toContain('data-artifact-canvas-viewport');
      expect(markup).toContain('data-artifact-canvas-content');
      expect(markup).not.toContain('width:1200px');
    });

    it('tree format shares the same canvas viewport (전 포맷 통일 — html-only 분기 소멸)', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_EDITABLE_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(markup).toContain('트리 렌더는 준비 중');
      expect(markup).toContain('data-artifact-canvas-viewport');
    });

    it('marks the html iframe pointer-events:none (crux — 상시 캡처 오버레이 폐기, iframe은 렌더된 오브젝트일 뿐)', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(markup).toContain('pointer-events-none');
    });

    it('never renders the v1~v2.1 scroll/overlay remnants (data-artifact-stage-scroll·data-pan-overlay·고정폭 잘림 카피)', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(markup).not.toContain('data-artifact-stage-scroll');
      expect(markup).not.toContain('data-pan-overlay');
      expect(markup).not.toContain('끌어서 이동');
    });

    it('shows the expand("크게 보기") entry point only for html format, not tree/image (기존 스코프 유지)', () => {
      const htmlMarkup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(htmlMarkup).toContain('크게 보기');

      const treeMarkup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_EDITABLE_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(treeMarkup).not.toContain('크게 보기');
    });

    it('the expand dialog is not rendered in the DOM when closed by default (base-ui portal, no leaked markup)', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
      );
      expect(markup).not.toContain('90vw');
    });

    it('renders the coordinate-anchor pin overlay inside the canvas content layer (description pane 부활의 전제)', () => {
      const markup = renderToStaticMarkup(
        wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} />),
      );
      expect(markup).toContain('data-artifact-canvas-overlay');
    });
  });
});
