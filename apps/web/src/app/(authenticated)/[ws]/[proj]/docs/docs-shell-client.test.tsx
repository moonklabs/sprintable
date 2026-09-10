import { describe, expect, it } from 'vitest';
import { DocsShellClient, getDocSaveStatusText } from './docs-shell-client';

// Minimal i18n stub — maps keys used by the save-status indicator
const t = (key: string): string =>
  ({
    statusSaved: 'Saved',
    statusUnsaved: 'Unsaved changes',
    statusError: 'Save failed',
    statusConflict: 'Conflict: another user edited this document',
    statusRemoteChanged: 'This document was updated remotely',
  })[key] ?? key;

// story #3787 — 「저장 중…」은 이제 common ns(tc)에서 온다(docs.statusSaving 걷음).
const tc = (key: string): string => ({ saving: 'Saving…' })[key] ?? key;

describe('DocsShellClient', () => {
  it('exports DocsShellClient as a function', () => {
    expect(typeof DocsShellClient).toBe('function');
  });
});

describe('getDocSaveStatusText', () => {
  it('returns null for idle status — no indicator shown when nothing is happening', () => {
    expect(getDocSaveStatusText('idle', t, tc)).toBeNull();
  });

  it('returns saving text while autosave is in flight', () => {
    expect(getDocSaveStatusText('saving', t, tc)).toBe('Saving…');
  });

  it('returns saved text after successful autosave', () => {
    expect(getDocSaveStatusText('saved', t, tc)).toBe('Saved');
  });

  it('returns unsaved text when doc is dirty and autosave has not fired yet', () => {
    expect(getDocSaveStatusText('unsaved', t, tc)).toBe('Unsaved changes');
  });

  it('returns error text when the PATCH request fails', () => {
    expect(getDocSaveStatusText('error', t, tc)).toBe('Save failed');
  });

  it('returns conflict text when server returns 409', () => {
    expect(getDocSaveStatusText('conflict', t, tc)).toBe(
      'Conflict: another user edited this document',
    );
  });

  it('returns remote-changed text when poll detects a newer server version', () => {
    expect(getDocSaveStatusText('remote-changed', t, tc)).toBe(
      'This document was updated remotely',
    );
  });
});
