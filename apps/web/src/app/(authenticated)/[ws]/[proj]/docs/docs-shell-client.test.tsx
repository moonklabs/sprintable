import { describe, expect, it } from 'vitest';
import { DocsShellClient, getDocSaveStatusText } from './docs-shell-client';

// Minimal i18n stub — maps keys used by the save-status indicator
const t = (key: string): string =>
  ({
    statusSaving: 'Saving...',
    statusSaved: 'Saved',
    statusUnsaved: 'Unsaved changes',
    statusError: 'Save failed',
    statusConflict: 'Conflict: another user edited this document',
    statusRemoteChanged: 'This document was updated remotely',
  })[key] ?? key;

describe('DocsShellClient', () => {
  it('exports DocsShellClient as a function', () => {
    expect(typeof DocsShellClient).toBe('function');
  });
});

describe('getDocSaveStatusText', () => {
  it('returns null for idle status — no indicator shown when nothing is happening', () => {
    expect(getDocSaveStatusText('idle', t)).toBeNull();
  });

  it('returns saving text while autosave is in flight', () => {
    expect(getDocSaveStatusText('saving', t)).toBe('Saving...');
  });

  it('returns saved text after successful autosave', () => {
    expect(getDocSaveStatusText('saved', t)).toBe('Saved');
  });

  it('returns unsaved text when doc is dirty and autosave has not fired yet', () => {
    expect(getDocSaveStatusText('unsaved', t)).toBe('Unsaved changes');
  });

  it('returns error text when the PATCH request fails', () => {
    expect(getDocSaveStatusText('error', t)).toBe('Save failed');
  });

  it('returns conflict text when server returns 409', () => {
    expect(getDocSaveStatusText('conflict', t)).toBe(
      'Conflict: another user edited this document',
    );
  });

  it('returns remote-changed text when poll detects a newer server version', () => {
    expect(getDocSaveStatusText('remote-changed', t)).toBe(
      'This document was updated remotely',
    );
  });
});
