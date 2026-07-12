import { describe, expect, it } from 'vitest';
import { parseArtifactTree } from './artifact-stage';

describe('parseArtifactTree', () => {
  it('parses a valid node array', () => {
    const content = JSON.stringify([{ id: 'n1', type: 'Card', children: [{ id: 'n2', type: 'Text', props: { text: 'hi' } }] }]);
    const tree = parseArtifactTree(content);
    expect(tree).not.toBeNull();
    expect(tree?.[0]?.id).toBe('n1');
    expect(tree?.[0]?.children?.[0]?.props?.text).toBe('hi');
  });

  it('returns null for malformed JSON (no crash)', () => {
    expect(parseArtifactTree('not json')).toBeNull();
  });

  it('returns null when content is not an array', () => {
    expect(parseArtifactTree(JSON.stringify({ id: 'n1', type: 'Card' }))).toBeNull();
  });

  it('returns null when array items lack required fields', () => {
    expect(parseArtifactTree(JSON.stringify([{ id: 'n1' }]))).toBeNull();
  });
});
