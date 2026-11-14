// story #4927 AC1 — the e2e web server (`pnpm dev`, Next dev) run through a thin shell that reads its output with the clock and keeps ONLY an allowlisted summary of it in a file. Why: Next dev compiles a route the
// first time it is asked for, and a spec that waits for a response (the contrast guard's «page marker») cannot tell «the request went out late» from «the server was compiling» without the server's own timings —
// and they were never collected (playwright's webServer.stdout defaults to 'ignore'; only stderr reached the CI log, with no time).
//
// What is kept is a FIXED LIST OF FIELDS (server-line-allowlist.mjs): request method · route (pathname only) · status · ms and Next's named sub-timings · compile route · ms · ready ms · an error NAME and its code.
// The raw line is never written anywhere — not to the file, not to stdout (= the CI log): a field list cannot hold a header, a cookie, a body, a URL, an env value or any other raw text, so nothing needs masking.
//
//   file  : $E2E_WEBSERVER_LOG, one record each «<epoch ms>\t<json of the allowed fields>» (appended; the spec reads the window of one test from it)
//   stdout: «[next hh:mm:ss.mmm] <one-line form of the record>» (playwright prints it as `[WebServer] …` when webServer.stdout is 'pipe'); nothing for a line that has no allowed field
// Nothing else changes: the same command, the same env, the same exit code. $E2E_DEV_SERVER_CMD is for the wrapper's own test only.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { formatRecord, parseServerLine } from './server-line-allowlist.mjs';

const logFile = process.env.E2E_WEBSERVER_LOG;
const command = process.env.E2E_DEV_SERVER_CMD || 'pnpm dev';

if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });

const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
};

function lineSink(stream) {
  let rest = '';
  const emit = (text) => {
    const rec = parseServerLine(text);
    if (!rec) return; // no allowed field in this line — dropped, never stored
    const now = Date.now();
    if (logFile) appendFileSync(logFile, `${now}\t${JSON.stringify(rec)}\n`);
    process.stdout.write(`[next ${stamp(now)}] ${formatRecord(rec)}\n`);
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    let at;
    while ((at = rest.indexOf('\n')) >= 0) {
      emit(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
  });
  stream.on('end', () => { if (rest) emit(rest); rest = ''; });
}

const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
lineSink(child.stdout);
lineSink(child.stderr);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill(sig); });
child.on('close', (code, signal) => {
  // wait for the pipes to drain (close, not exit), then leave with the child's own result
  process.exit(code ?? (signal ? 1 : 0));
});
