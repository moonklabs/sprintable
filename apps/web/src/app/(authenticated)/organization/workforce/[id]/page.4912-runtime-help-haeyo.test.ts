// story 4912 (follow-up) — the two «런타임 타입» help lines on the agent detail page were written in the plain form («…달라진다» · «…않는다»), the rest of the screen says «해요».
import { describe, expect, it } from 'vitest';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

const S = koMessages.settings;

describe('에이전트 상세 «런타임 타입» 설명 — 해요체(story 4912)', () => {
  it('⭐설명 두 줄이 해요체로 끝난다 — 옛 다체로 되돌리면 RED', () => {
    expect(S.runtimeTypeDescription).toBe('이 에이전트가 실행되는 런타임이에요. 채팅 슬래시 커맨드 지원 여부는 런타임에 따라 달라요.');
    expect(S.runtimeUnsupportedHelp).toBe('이 런타임은 슬래시 커맨드를 실행하지 않아요.');
  });

  it('문장마다 «요.»로 끝난다(다체 «다.» 끝이 하나도 없다)', () => {
    for (const line of [S.runtimeTypeDescription, S.runtimeUnsupportedHelp]) {
      const sentences = line.split(/(?<=\.)\s+/);
      for (const s of sentences) expect(s.endsWith('요.'), `«${s}»`).toBe(true);
    }
  });

  it('영어 두 줄은 그대로(이 장은 ko 말투만)', () => {
    expect(enMessages.settings.runtimeTypeDescription).toBe('The runtime this agent runs on. Chat slash-command support depends on the runtime.');
    expect(enMessages.settings.runtimeUnsupportedHelp).toBe('This runtime does not execute slash commands.');
  });
});
