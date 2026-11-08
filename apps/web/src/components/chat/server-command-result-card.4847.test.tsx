// @vitest-environment jsdom
// story 4847 (AC-명령) — a catalog command typed in a room with no project: the server answers with a card marked `server_command.code = ROOM_HAS_NO_PROJECT`
// (outcome `denied`, an English fallback line as `content`); the web draws OUR words — what did not work + the way that does. Any other code, and no code: the card as before.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ServerCommandResultCard } from './server-command-result-card';
import { normalizeToMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const FALLBACK = 'This command works in a room that has a project.';

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const draw = async (serverCommand: React.ComponentProps<typeof ServerCommandResultCard>['serverCommand'], content = FALLBACK, locale: 'ko' | 'en' = 'ko') => {
  await act(async () => { root.render(wrap(<ServerCommandResultCard content={content} serverCommand={serverCommand} />, locale)); });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ServerCommandResultCard — ROOM_HAS_NO_PROJECT(story 4847)', () => {
  it('⭐코드를 받으면 우리 문구로: 무엇이 안 됐는지(명령 이름 포함) + 할 수 있는 길, 서버의 영어 글은 안 보인다', async () => {
    await draw({ command: 'assign', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' });
    expect(container.textContent).toContain('이 방에는 프로젝트가 없어 /assign 명령을 쓸 수 없어요');
    expect(container.textContent).toContain('스토리 번호는 프로젝트마다 따로');
    expect(container.querySelector('[data-testid="server-command-way"]')?.textContent).toContain('프로젝트가 있는 방에서 명령을 쳐 주세요');
    expect(container.textContent).not.toContain(FALLBACK);
    expect(container.textContent).toContain('서버 집행'); // the badge stays: it is the server who answers
    expect(container.querySelector('.bg-destructive')).not.toBeNull(); // denied
  });

  it('⭐명령 이름은 친 것을 따른다(done · priority)', async () => {
    await draw({ command: 'priority', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' });
    expect(container.textContent).toContain('/priority 명령');
    await draw({ command: 'done', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' });
    expect(container.textContent).toContain('/done 명령');
  });

  it('⭐영어 화면은 영어 우리 문구', async () => {
    await draw({ command: 'done', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' }, FALLBACK, 'en');
    expect(container.textContent).toContain('This room has no project, so /done cannot run here');
    expect(container.querySelector('[data-testid="server-command-way"]')?.textContent).toContain('Type the command in a room that has a project.');
  });

  it('⭐코드가 없는 denied 카드는 지금 그대로 — 서버 글이 그대로, 길 칸 없음', async () => {
    await draw({ command: 'done', outcome: 'denied' }, "'/done' 실패 — 이 작업을 실행할 권한이 없습니다.");
    expect(container.textContent).toContain("'/done' 실패 — 이 작업을 실행할 권한이 없습니다.");
    expect(container.textContent).not.toContain('이 방에는 프로젝트가 없어');
    expect(container.querySelector('[data-testid="server-command-way"]')).toBeNull();
  });

  it('⭐모르는 코드도 지금 그대로(깨지지 않는다)', async () => {
    await draw({ command: 'done', outcome: 'denied', code: 'SOMETHING_NEW' }, "'/done' 실패 — 새 사유");
    expect(container.textContent).toContain("'/done' 실패 — 새 사유");
    expect(container.querySelector('[data-testid="server-command-way"]')).toBeNull();
  });

  it('⭐이 코드는 denied일 때만 이 카드 — 다른 outcome에 실려 와도 지금 카드 그대로', async () => {
    await draw({ command: 'done', outcome: 'executed', code: 'ROOM_HAS_NO_PROJECT' }, "'/done' 완료 — 전이됐습니다.");
    expect(container.textContent).toContain("'/done' 완료 — 전이됐습니다.");
    expect(container.querySelector('[data-testid="server-command-way"]')).toBeNull();
  });

  it('⭐서버가 보낸 그대로의 메시지(normalizeToMessage)가 code를 잃지 않는다', () => {
    const msg = normalizeToMessage({ id: 'm1', content: FALLBACK, server_command: { command: 'assign', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' } });
    expect(msg.server_command).toEqual({ command: 'assign', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' });
  });

  it('코드가 있는 카드에 후보 존 · 다음 행동 박스는 안 뜬다', async () => {
    await draw({ command: 'assign', outcome: 'denied', code: 'ROOM_HAS_NO_PROJECT' });
    expect(container.textContent).not.toContain('후보');
    expect(container.textContent).not.toContain('다음 행동');
  });
});
