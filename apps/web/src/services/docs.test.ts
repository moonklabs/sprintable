import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsService } from './docs';

function createDocsDb(options?: {
  updateResult?: Record<string, unknown> | null;
  currentUpdatedAt?: string;
}) {
  const updateBuilder = {
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn(),
  };
  updateBuilder.eq.mockImplementation(() => updateBuilder);
  updateBuilder.select.mockImplementation(() => updateBuilder);
  updateBuilder.maybeSingle.mockResolvedValue({ data: options?.updateResult ?? { id: 'doc-1', content: 'updated' }, error: null });

  const readBuilder = {
    eq: vi.fn(),
    single: vi.fn(),
  };
  readBuilder.eq.mockImplementation(() => readBuilder);
  readBuilder.single.mockResolvedValue({
    data: { updated_at: options?.currentUpdatedAt ?? '2026-04-09T15:20:00.000Z' },
    error: null,
  });

  const docsTable = {
    update: vi.fn(() => updateBuilder),
    select: vi.fn(() => readBuilder),
  };

  const db = {
    from: vi.fn((table: string) => {
      if (table !== 'docs') throw new Error(`Unexpected table: ${table}`);
      return docsTable;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return { db, updateBuilder, readBuilder };
}

describe('DocsService.updateDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies optimistic concurrency when expected_updated_at is provided', async () => {
    const { db, updateBuilder } = createDocsDb();
    const service = new DocsService({} as never, db as never);

    const result = await service.updateDoc('doc-1', {
      content: 'updated',
      content_format: 'markdown',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
      created_by: 'team-member-1',
    });

    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(updateBuilder.eq).toHaveBeenCalledWith('updated_at', '2026-04-09T15:19:00.000Z');
    expect(db.rpc).toHaveBeenCalledWith('trim_doc_revisions', { _doc_id: 'doc-1', _keep: 50 });
    expect(result).toEqual(expect.objectContaining({ id: 'doc-1', content: 'updated' }));
  });

  it('throws a conflict error when updated_at no longer matches', async () => {
    const { db, updateBuilder, readBuilder } = createDocsDb({
      updateResult: null,
      currentUpdatedAt: '2026-04-09T15:21:00.000Z',
    });
    updateBuilder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const service = new DocsService({} as never, db as never);

    await expect(service.updateDoc('doc-1', {
      content: 'stale update',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
    })).rejects.toMatchObject({
      message: 'Document was modified by another user',
      code: 'CONFLICT',
      server_updated_at: '2026-04-09T15:21:00.000Z',
    });

    expect(readBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('allows explicit overwrite after a conflict acknowledgement', async () => {
    const { db, updateBuilder } = createDocsDb();
    const service = new DocsService({} as never, db as never);

    await service.updateDoc('doc-1', {
      content: 'overwrite me',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
      force_overwrite: true,
    });

    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(updateBuilder.eq).not.toHaveBeenCalledWith('updated_at', '2026-04-09T15:19:00.000Z');
    expect(db.rpc).toHaveBeenCalledWith('trim_doc_revisions', { _doc_id: 'doc-1', _keep: 50 });
  });
});
