import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';
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
});
