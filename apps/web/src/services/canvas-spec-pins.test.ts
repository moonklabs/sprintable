import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adaptSpecPin, listSpecPins, createSpecPin, updateSpecPin, deleteSpecPin, type BeSpecPin,
} from './canvas-spec-pins';

const BE_PIN: BeSpecPin = {
  id: 'p1', artifact_id: 'a1', version_id: 'v1', anchor_type: 'coord',
  anchor_x: 640, anchor_y: 400, node_id: null, description: '헤더는 primary 배경입니다.',
};

describe('adaptSpecPin (BE SpecPinResponse 미러 — 감시금지: created_by/created_at 자체가 없음)', () => {
  it('maps snake_case fields to the FE camelCase shape', () => {
    expect(adaptSpecPin(BE_PIN)).toEqual({
      id: 'p1', artifactId: 'a1', versionId: 'v1', anchorType: 'coord',
      anchorX: 640, anchorY: 400, nodeId: null, description: '헤더는 primary 배경입니다.',
    });
  });

  it('falls back any unexpected anchor_type value to coord (v1 스코프 — node 배치는 후속, 방어적 기본값)', () => {
    expect(adaptSpecPin({ ...BE_PIN, anchor_type: 'unknown' }).anchorType).toBe('coord');
  });

  it('preserves node anchor_type as-is when the BE returns it', () => {
    expect(adaptSpecPin({ ...BE_PIN, anchor_type: 'node', anchor_x: null, anchor_y: null, node_id: 'n1' }).anchorType).toBe('node');
  });
});

describe('listSpecPins/createSpecPin/updateSpecPin/deleteSpecPin (fetch 경유, story 7fe16274)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listSpecPins GETs the pins route and adapts each row', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [BE_PIN] }) });
    const pins = await listSpecPins('a1');
    expect(fetchMock).toHaveBeenCalledWith('/api/visual-artifacts/a1/pins', undefined);
    expect(pins).toEqual([adaptSpecPin(BE_PIN)]);
  });

  it('listSpecPins returns an empty array (not null) on failure — no-fiction empty state, not a crash', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await listSpecPins('a1')).toEqual([]);
  });

  it('createSpecPin POSTs anchor_type=coord with the given coordinates and description', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: BE_PIN }) });
    const pin = await createSpecPin('a1', 640, 400, '헤더는 primary 배경입니다.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/visual-artifacts/a1/pins');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ anchor_type: 'coord', anchor_x: 640, anchor_y: 400, description: '헤더는 primary 배경입니다.' });
    expect(pin).toEqual(adaptSpecPin(BE_PIN));
  });

  it('updateSpecPin PATCHes only the description', async () => {
    const updated = { ...BE_PIN, description: '수정됨' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: updated }) });
    const pin = await updateSpecPin('a1', 'p1', '수정됨');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/visual-artifacts/a1/pins/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ description: '수정됨' });
    expect(pin?.description).toBe('수정됨');
  });

  it('deleteSpecPin DELETEs and returns the response ok-ness', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await deleteSpecPin('a1', 'p1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/visual-artifacts/a1/pins/p1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteSpecPin returns false on network failure (no throw)', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await deleteSpecPin('a1', 'p1')).toBe(false);
  });
});
