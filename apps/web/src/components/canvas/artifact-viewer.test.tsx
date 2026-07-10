import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';

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
});
