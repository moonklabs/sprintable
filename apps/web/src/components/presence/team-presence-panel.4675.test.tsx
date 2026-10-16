// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · Yuna §I ⑤) — the presence row's fallback line ends with « · {컴퓨터}» as text (one line stays one
// line); no computer → no tail.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TeamPresencePanel } from './team-presence-panel';
import type { TeamPresenceItem } from './use-team-presence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const item = (o: Partial<TeamPresenceItem>): TeamPresenceItem => ({ member_id: 'm1', name: '조사', working: false, presence_status: 'online', agent_role: '리서처', runtime_type: 'claude-code', ...o });

describe('[SID:4675] TeamPresencePanel — the computer at the end of the line', () => {
  it('device_name → « · yoonjae의 맥» after the role · runtime; null → the line as before', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TeamPresencePanel items={[item({ member_id: 'm1', device_name: 'yoonjae의 맥' }), item({ member_id: 'm2', name: '작성', device_name: null })]} authFailureByMember={{}} />
      </NextIntlClientProvider>);
    });
    const lines = [...container.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(lines.find((l) => l.includes('조사'))).toContain('리서처 · Claude Code · yoonjae의 맥'); // reverted → no tail
    expect(lines.find((l) => l.includes('작성'))).toMatch(/리서처 · Claude Code$/);
    expect(container.querySelectorAll('[data-testid=device-chip]')).toHaveLength(0); // text, not a chip
  });
});
