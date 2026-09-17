// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC7 — v3 화면 파일에 EventSource/연결
// 생성 코드가 직접 있으면 안 된다(전부 useChatSse 경유만 허용 — 화면마다 따로 SSE를
// 붙이면 연결이 화면 수만큼 늘고 복붙이 생긴다는 스토리 본문의 우려를 grep으로 고정).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_V3_DIR = path.resolve(SCRIPT_DIR, '../src/components/chat-v3');

function realCodeLines(src: string): string[] {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'));
}

describe('verify-chat-v3-no-raw-eventsource(story #4008 AC7)', () => {
  it('chat-v3-*.tsx 화면 파일 전부에 EventSource 직접 생성 코드가 0건이다', () => {
    const files = fs.readdirSync(CHAT_V3_DIR).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(CHAT_V3_DIR, file), 'utf-8');
      if (realCodeLines(src).some((line) => line.includes('EventSource'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('양성 대조 — EventSource를 실제로 여는 useChatSse 훅 자체는 이 디렉터리 밖(hooks/)에 있다', () => {
    const hookSrc = fs.readFileSync(path.resolve(SCRIPT_DIR, '../src/hooks/use-chat-sse.ts'), 'utf-8');
    expect(hookSrc.includes('new EventSource(')).toBe(true);
  });
});
