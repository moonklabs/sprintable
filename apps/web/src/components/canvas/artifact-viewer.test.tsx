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

  it('sandboxes the html stage without allow-scripts (감시/보안 게이트 — 핸드오프 §3-1)', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).toContain('sandbox="allow-same-origin"');
    expect(markup).not.toContain('allow-scripts');
  });

  it('omits the anchor badge entirely when the artifact has no anchor version yet (초안 중립·낙인 금지)', () => {
    const draftArtifact = { ...MOCK_ARTIFACT, anchor_version: null };
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={draftArtifact} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).not.toContain('정본 v');
  });
});
