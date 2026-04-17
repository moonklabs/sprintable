import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsService } from './docs';

function createDocsSupabase(options?: {
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

  const supabase = {
    from: vi.fn((table: string) => {
      if (table !== 'docs') throw new Error(`Unexpected table: ${table}`);
      return docsTable;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return { supabase, updateBuilder, readBuilder };
}

describe('DocsService.updateDoc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies optimistic concurrency when expected_updated_at is provided', async () => {
    const { supabase, updateBuilder } = createDocsSupabase();
    const service = new DocsService(supabase as never);

    const result = await service.updateDoc('doc-1', {
      content: 'updated',
      content_format: 'markdown',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
      created_by: 'team-member-1',
    });

    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(updateBuilder.eq).toHaveBeenCalledWith('updated_at', '2026-04-09T15:19:00.000Z');
    expect(supabase.rpc).toHaveBeenCalledWith('trim_doc_revisions', { _doc_id: 'doc-1', _keep: 50 });
    expect(result).toEqual(expect.objectContaining({ id: 'doc-1', content: 'updated' }));
  });

  it('throws a conflict error when updated_at no longer matches', async () => {
    const { supabase, updateBuilder, readBuilder } = createDocsSupabase({
      updateResult: null,
      currentUpdatedAt: '2026-04-09T15:21:00.000Z',
    });
    updateBuilder.maybeSingle.mockResolvedValue({ data: null, error: null });
    const service = new DocsService(supabase as never);

    await expect(service.updateDoc('doc-1', {
      content: 'stale update',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
    })).rejects.toMatchObject({
      message: 'Document was modified by another user',
      code: 'CONFLICT',
      server_updated_at: '2026-04-09T15:21:00.000Z',
    });

    expect(readBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('allows explicit overwrite after a conflict acknowledgement', async () => {
    const { supabase, updateBuilder } = createDocsSupabase();
    const service = new DocsService(supabase as never);

    await service.updateDoc('doc-1', {
      content: 'overwrite me',
      expected_updated_at: '2026-04-09T15:19:00.000Z',
      force_overwrite: true,
    });

    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'doc-1');
    expect(updateBuilder.eq).not.toHaveBeenCalledWith('updated_at', '2026-04-09T15:19:00.000Z');
    expect(supabase.rpc).toHaveBeenCalledWith('trim_doc_revisions', { _doc_id: 'doc-1', _keep: 50 });
  });
});
