import { describe, expect, it } from 'vitest';
import { adaptArtifactDetail, type VisualArtifactDetailResponse } from './canvas';

const BASE_ARTIFACT = {
  id: 'a1', title: 'Test', current_version: 1, anchor_version: null,
  created_by: 'm1', source: 'created' as const,
};

describe('adaptArtifactDetail (AC2 attachment point — provisional BE envelope)', () => {
  it('serializes a tree-format artifact into nested-tree JSON content via resolveNodeTree', () => {
    const detail: VisualArtifactDetailResponse = {
      artifact: { ...BASE_ARTIFACT, format: 'tree' },
      version_number: 1,
      nodes: [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0 }],
    };
    const { versions } = adaptArtifactDetail(detail);
    expect(versions).toHaveLength(1);
    const parsed = JSON.parse(versions[0]!.content);
    expect(parsed[0].id).toBe('n1');
  });

  it('extracts html content from the html_blob catch-all node for html-format artifacts', () => {
    const detail: VisualArtifactDetailResponse = {
      artifact: { ...BASE_ARTIFACT, format: 'html' },
      version_number: 2,
      nodes: [{ id: 'blob', type: 'html_blob', props: { html: '<p>hi</p>' }, parent_id: null, sort_order: 0 }],
    };
    const { versions } = adaptArtifactDetail(detail);
    expect(versions[0]!.content).toBe('<p>hi</p>');
    expect(versions[0]!.version).toBe(2);
  });

  it('extracts the src field from the html_blob node for image-format artifacts', () => {
    const detail: VisualArtifactDetailResponse = {
      artifact: { ...BASE_ARTIFACT, format: 'image' },
      version_number: 1,
      nodes: [{ id: 'blob', type: 'html_blob', props: { src: 'https://example.com/x.png' }, parent_id: null, sort_order: 0 }],
    };
    const { versions } = adaptArtifactDetail(detail);
    expect(versions[0]!.content).toBe('https://example.com/x.png');
  });

  it('falls back to empty content (not a crash) when the expected blob node is missing', () => {
    const detail: VisualArtifactDetailResponse = {
      artifact: { ...BASE_ARTIFACT, format: 'html' },
      version_number: 1,
      nodes: [],
    };
    const { versions } = adaptArtifactDetail(detail);
    expect(versions[0]!.content).toBe('');
  });
});
