import { describe, expect, it } from 'vitest';
import { adaptArtifactDetail, deriveFormat, type BeVisualArtifactDetail } from './canvas';

const BASE_DETAIL = {
  id: 'a1', title: 'Test', story_id: 's1', epic_id: null, doc_id: null,
  source: 'created' as const, latest_version_number: 1, anchor_version: null,
  created_by: 'm1', created_at: '2026-07-10T00:00:00Z',
  version_number: 1, version_summary: null,
};

describe('deriveFormat (BE has no format column — derived from node composition)', () => {
  it('returns tree when no html_blob catch-all node is present', () => {
    expect(deriveFormat([{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0 }])).toBe('tree');
  });

  it('returns html when html_blob node has an html prop', () => {
    expect(deriveFormat([{ id: 'blob', type: 'html_blob', props: { html: '<p>hi</p>' }, parent_id: null, sort_order: 0 }])).toBe('html');
  });

  it('returns image when html_blob node has a src prop', () => {
    expect(deriveFormat([{ id: 'blob', type: 'html_blob', props: { src: 'https://example.com/x.png' }, parent_id: null, sort_order: 0 }])).toBe('image');
  });
});

describe('adaptArtifactDetail (AC2 attachment point — real BE schema, flat envelope)', () => {
  it('serializes a tree-format artifact into nested-tree JSON content via resolveNodeTree', () => {
    const detail: BeVisualArtifactDetail = {
      ...BASE_DETAIL,
      nodes: [{ id: 'n1', type: 'Card', props: {}, parent_id: null, sort_order: 0 }],
    };
    const { artifact, versions } = adaptArtifactDetail(detail);
    expect(artifact.format).toBe('tree');
    expect(artifact.current_version).toBe(1);
    expect(versions).toHaveLength(1);
    const parsed = JSON.parse(versions[0]!.content);
    expect(parsed[0].id).toBe('n1');
  });

  it('extracts html content from the html_blob catch-all node for html-format artifacts', () => {
    const detail: BeVisualArtifactDetail = {
      ...BASE_DETAIL,
      version_number: 2,
      nodes: [{ id: 'blob', type: 'html_blob', props: { html: '<p>hi</p>' }, parent_id: null, sort_order: 0 }],
    };
    const { artifact, versions } = adaptArtifactDetail(detail);
    expect(artifact.format).toBe('html');
    expect(versions[0]!.content).toBe('<p>hi</p>');
    expect(versions[0]!.version).toBe(2);
  });

  it('extracts the src field from the html_blob node for image-format artifacts', () => {
    const detail: BeVisualArtifactDetail = {
      ...BASE_DETAIL,
      nodes: [{ id: 'blob', type: 'html_blob', props: { src: 'https://example.com/x.png' }, parent_id: null, sort_order: 0 }],
    };
    const { artifact, versions } = adaptArtifactDetail(detail);
    expect(artifact.format).toBe('image');
    expect(versions[0]!.content).toBe('https://example.com/x.png');
  });

  it('treats an empty node list as an empty tree (not a crash) — format is derived, so no-blob always means tree', () => {
    const detail: BeVisualArtifactDetail = { ...BASE_DETAIL, nodes: [] };
    const { artifact, versions } = adaptArtifactDetail(detail);
    expect(artifact.format).toBe('tree');
    expect(versions[0]!.content).toBe('[]');
  });

  it('falls back to empty content (not a crash) when an html_blob node exists but its expected prop key is missing', () => {
    const detail: BeVisualArtifactDetail = {
      ...BASE_DETAIL,
      nodes: [{ id: 'blob', type: 'html_blob', props: {}, parent_id: null, sort_order: 0 }],
    };
    const { artifact, versions } = adaptArtifactDetail(detail);
    expect(artifact.format).toBe('html');
    expect(versions[0]!.content).toBe('');
  });

  it('maps latest_version_number to current_version and preserves story/epic/doc link keys', () => {
    const detail: BeVisualArtifactDetail = { ...BASE_DETAIL, latest_version_number: 7, nodes: [] };
    const { artifact } = adaptArtifactDetail(detail);
    expect(artifact.current_version).toBe(7);
    expect(artifact.story_id).toBe('s1');
    expect(artifact.epic_id).toBeNull();
    expect(artifact.doc_id).toBeNull();
  });
});
