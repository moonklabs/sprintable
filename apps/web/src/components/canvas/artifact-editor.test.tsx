import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { CommitBar } from './commit-bar';
import { ConcurrencyPrompt } from './concurrency-prompt';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS, MOCK_EDITABLE_ARTIFACT } from '@/services/canvas';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const EDIT_BUTTON_MARKER = 'lucide-pencil';

describe('ArtifactViewer edit-entry (C3 §1 뷰어→편집모드)', () => {
  it('does not show an edit button for html-format artifacts (편집 UI는 tree 전용)', () => {
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onEnterEdit={() => {}} />),
    );
    expect(markup).not.toContain(EDIT_BUTTON_MARKER);
  });

  it('shows "새 버전으로 편집" when viewing the anchor version, "편집" otherwise', () => {
    const treeVersions = [{ id: 'v1', artifact_id: MOCK_EDITABLE_ARTIFACT.id, version: 1, content: '[]', created_by: 'm1', summary: null, created_at: '2026-07-10T00:00:00Z' }];
    const anchoredArtifact = { ...MOCK_EDITABLE_ARTIFACT, anchor_version: 1 };
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={anchoredArtifact} versions={treeVersions} memberMap={MOCK_MEMBERS} onEnterEdit={() => {}} />),
    );
    expect(markup).toContain('새 버전으로 편집');
  });

  it('omits the edit button entirely when no onEnterEdit handler is given (read-only embed stays read-only)', () => {
    const treeVersions = [{ id: 'v1', artifact_id: MOCK_EDITABLE_ARTIFACT.id, version: 1, content: '[]', created_by: 'm1', summary: null, created_at: '2026-07-10T00:00:00Z' }];
    const markup = renderToStaticMarkup(
      wrap(<ArtifactViewer artifact={MOCK_EDITABLE_ARTIFACT} versions={treeVersions} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).not.toContain(EDIT_BUTTON_MARKER);
  });
});

describe('C3 감시-게이트 회귀가드 (§4 — 편집 표면은 CCTV로 가장 미끄러지기 쉬운 지점)', () => {
  it('CommitBar never mentions edit count/speed vocabulary, only a neutral change count', () => {
    const markup = renderToStaticMarkup(wrap(<CommitBar changeCount={3} onCommit={() => {}} />));
    expect(markup).toContain('변경 3건');
    for (const forbidden of ['속도', '점유', '뺏김', '몇 번', '횟수']) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it('CommitBar disables the save action when there are no changes (no empty commits)', () => {
    const markup = renderToStaticMarkup(wrap(<CommitBar changeCount={0} onCommit={() => {}} />));
    expect(markup).toContain('disabled=""');
  });

  it('ConcurrencyPrompt frames the other author\'s edit as calm collaboration, not a conflict/competition', () => {
    const markup = renderToStaticMarkup(
      wrap(<ConcurrencyPrompt authorName="디디 은와추쿠" version={5} onView={() => {}} onMergeOver={() => {}} />),
    );
    expect(markup).toContain('디디 은와추쿠');
    for (const forbidden of ['충돌', '경쟁', '뺏김', '덮어쓰기']) {
      expect(markup).not.toContain(forbidden);
    }
    expect(markup).not.toContain('text-destructive');
  });
});
