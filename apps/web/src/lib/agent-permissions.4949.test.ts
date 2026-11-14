// story 4949 — the summary a request's list row shows, and the card's summary without the old Korean mask word.
import { describe, expect, it } from 'vitest';
import { rowSummary, shownSummary } from './agent-permissions';

describe('rowSummary (story 4949)', () => {
  it('a short file name or path is shown whole; a command is shown whole (the row truncates it)', () => {
    expect(rowSummary({ tool: 'Write', summary: 'note.txt', masked: false })).toBe('note.txt');
    expect(rowSummary({ tool: 'Edit', summary: 'src/a/b.ts', masked: false })).toBe('src/a/b.ts');
    expect(rowSummary({ tool: 'Bash', summary: 'npm install --save left-pad && npm test', masked: false })).toBe('npm install --save left-pad && npm test');
  });
  it('a file tool\'s long path keeps its end — the folder it sits in and the file name', () => {
    expect(rowSummary({ tool: 'Write', summary: 'apps/web/src/components/inbox/approvals-queue.tsx', masked: false })).toBe('…/inbox/approvals-queue.tsx');
    expect(rowSummary({ tool: 'MultiEdit', summary: '/Users/me/projects/very-long-folder-name/src/index.ts', masked: false })).toBe('…/src/index.ts');
    expect(rowSummary({ tool: 'Bash', summary: 'cat /Users/me/projects/very-long-folder-name/src/index.ts', masked: false })).toBe('cat /Users/me/projects/very-long-folder-name/src/index.ts');
  });
  it('no summary → null; the old mask word is not shown on a masked summary', () => {
    expect(rowSummary({ tool: null, summary: null, masked: false })).toBeNull();
    expect(rowSummary({ tool: 'Write', summary: '', masked: false })).toBeNull();
    expect(rowSummary({ tool: 'Write', summary: '••••(가림).txt', masked: true })).toBe('••••.txt');
  });
});

describe('shownSummary (story 4949)', () => {
  it('rewrites the old word only on a summary the Mac masked', () => {
    expect(shownSummary('••••(가림).txt', true)).toBe('••••.txt');
    expect(shownSummary('echo ••••(가림)', false)).toBe('echo ••••(가림)');
  });
});
