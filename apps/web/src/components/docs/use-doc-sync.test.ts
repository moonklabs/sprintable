import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createAutosaveScheduler } from './use-doc-sync';

// ---------------------------------------------------------------------------
// createAutosaveScheduler — pure debounce factory (no React / no DOM needed)
// ---------------------------------------------------------------------------

describe('createAutosaveScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires the callback once after the configured delay', () => {
    const scheduler = createAutosaveScheduler(1500);
    const fn = vi.fn();

    scheduler.schedule(fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid calls — N keystrokes produce exactly 1 callback (debounce)', () => {
    const scheduler = createAutosaveScheduler(1500);
    const fn = vi.fn();

    // Simulate 5 rapid schedule() calls at 200 ms intervals (within the 1500 ms window)
    for (let i = 0; i < 5; i++) {
      scheduler.schedule(fn);
      vi.advanceTimersByTime(200);
    }

    // Still within the delay — callback not yet fired
    expect(fn).not.toHaveBeenCalled();

    // Advance past the final debounce window
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not fire after cancel()', () => {
    const scheduler = createAutosaveScheduler(1500);
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.cancel();

    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows a new schedule after cancel()', () => {
    const scheduler = createAutosaveScheduler(1500);
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.cancel();

    scheduler.schedule(fn);
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH fetch behavior — simulate the save() path that useDocSync calls
// ---------------------------------------------------------------------------

describe('useDocSync save PATCH behavior', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends PATCH to /api/docs/:id with content payload after debounce fires', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'doc-1', updated_at: '2026-01-02T00:00:00Z' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const scheduler = createAutosaveScheduler(1500);
    const payload = { title: 'Hello', content: '# World', content_format: 'markdown' };

    scheduler.schedule(async () => {
      await fetch('/api/docs/doc-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    });

    vi.advanceTimersByTime(1500);
    // Allow the async PATCH callback to resolve
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/docs/doc-1',
      expect.objectContaining({ method: 'PATCH' }),
    );

    const sentBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody).toEqual(payload);
  });

  it('sends only 1 PATCH when content changes 5 times within the debounce window', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'doc-1', updated_at: '2026-01-02T00:00:00Z' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const scheduler = createAutosaveScheduler(1500);

    for (let i = 0; i < 5; i++) {
      const content = `# Edit ${i}`;
      scheduler.schedule(async () => {
        await fetch('/api/docs/doc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      });
      vi.advanceTimersByTime(200);
    }

    vi.advanceTimersByTime(1500);
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The sent content should be from the last scheduled call
    const sentBody = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.content).toBe('# Edit 4');
  });
});
