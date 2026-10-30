import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fastapiBaseUrl } from './fastapi-url';

const KEYS = ['SPRINTABLE_API_ORIGIN', 'NEXT_PUBLIC_FASTAPI_URL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('story 4824 — the backend address, read at run time', () => {
  it('the run-time name wins; without it the build-time name; without both the local default (every cloud / dev setup is unchanged)', () => {
    delete process.env['SPRINTABLE_API_ORIGIN']; delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
    expect(fastapiBaseUrl()).toBe('http://localhost:8000');
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://api.example.com';
    expect(fastapiBaseUrl()).toBe('https://api.example.com');
    process.env['SPRINTABLE_API_ORIGIN'] = 'http://127.0.0.1:41234';
    expect(fastapiBaseUrl()).toBe('http://127.0.0.1:41234');
    process.env['SPRINTABLE_API_ORIGIN'] = '';
    expect(fastapiBaseUrl()).toBe('https://api.example.com'); // an empty value is no value
  });

  it('hosted setups (dev · prod set no SPRINTABLE_API_ORIGIN): the address is exactly what it was before this change — the build value, or the local default', () => {
    delete process.env['SPRINTABLE_API_ORIGIN'];
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://dev-api.sprintable.ai';
    expect(fastapiBaseUrl()).toBe('https://dev-api.sprintable.ai');
    delete process.env['NEXT_PUBLIC_FASTAPI_URL'];
    expect(fastapiBaseUrl()).toBe('http://localhost:8000');
  });

  it('the server side reads the address only through fastapiBaseUrl() — a NEXT_PUBLIC read anywhere else is baked into the build and ignores the run-time name', () => {
    const root = path.resolve(__dirname, '..', '..');
    const out = execFileSync('git', ['grep', '-n', '-E', "NEXT_PUBLIC_FASTAPI_URL", '--', 'src', ':!*.test.*', ':!*.test.tsx'], { cwd: root, encoding: 'utf8' });
    const code = out.split('\n').filter((l) => l && !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(l));
    // the allowed reads: the helper itself; the channel page (client — its fallback for an older token answer); the channels page's snippet text (client, display only)
    const stray = code.filter((l) => !/src\/lib\/fastapi-url\.ts:/.test(l) && !/src\/app\/\(authenticated\)\/channel\/page\.tsx:/.test(l) && !/src\/app\/\(authenticated\)\/organization\/channels\/page\.tsx:/.test(l));
    expect(stray).toEqual([]);
  });
});
