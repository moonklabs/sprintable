// story #4927 — what the diagnostics may keep of the Next dev server's output, and of a browser request: a FIXED LIST OF FIELDS, nothing else (PO 11-14: an allowlist, not a pattern list of what to mask).
//
// The server's stdout/stderr go to a file that CI uploads when the job fails (and to the job log). Masking secrets out of raw lines is a list that grows with every new shape of secret; so the raw line
// is never kept. Each line is read for the few things the investigation needs, and ONLY those fields are stored — everything else in the line is dropped on the floor:
//   request   method · route (pathname only; id-looking segments → :id) · status · total ms · the named sub-timings Next prints (compile · render · next.js · proxy.ts · application-code), numbers only
//   compile   «Compiling» / «Compiled» · route · ms
//   ready     the server's «Ready in» ms
//   error     the error NAME only if it is one of a FIXED SET of known names (else «Other») and, from a following line, its `code` only if it is one of a fixed set of known codes (else «OTHER») — never the message, a stack frame, a header or a value
// So the artifact cannot hold a header, a cookie, a body, a full URL, an env value or a raw line: there is no field for them. A route is only a path; a segment that looks like an id or a token is replaced.
export const SEGMENT_ID = ':id';
/** Error names and codes are NOT free text: an identifier-shaped secret would pass a «looks like an identifier» test, so only members of these fixed sets are ever kept. */
export const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'AbortError', 'TimeoutError', 'ResponseAborted', 'FetchError', 'NetworkError', 'SecurityError', 'NotFoundError',
]);
export const ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRINUSE', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENOMEM', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CONNECT_TIMEOUT',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_REQUEST_TIMEOUT', 'ERR_STREAM_DESTROYED', 'ERR_INVALID_STATE',
]);
export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Playwright's own resource types (a fixed vocabulary). */
export const RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']);
/** Chromium net error codes a failed request can carry — only these are kept; any other `net::ERR_*` text becomes `net::ERR_OTHER`. */
export const NET_ERRORS = new Set([
  'net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_CONNECTION_FAILED',
  'net::ERR_TIMED_OUT', 'net::ERR_EMPTY_RESPONSE', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NETWORK_CHANGED', 'net::ERR_ADDRESS_UNREACHABLE', 'net::ERR_SOCKET_NOT_CONNECTED',
  'net::ERR_INCOMPLETE_CHUNKED_ENCODING', 'net::ERR_CONTENT_LENGTH_MISMATCH', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_TOO_MANY_REDIRECTS', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_RESPONSE',
  'net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR', 'net::ERR_UNEXPECTED', 'net::ERR_INVALID_URL', 'net::ERR_ACCESS_DENIED',
]);
export const OTHER_NET_ERROR = 'net::ERR_OTHER';
export const DOC_READY_STATES = new Set(['loading', 'interactive', 'complete']);
export const safeMethod = (m) => (typeof m === 'string' && HTTP_METHODS.has(m.toUpperCase()) ? m.toUpperCase() : 'OTHER');
export const safeResourceType = (t) => (typeof t === 'string' && RESOURCE_TYPES.has(t) ? t : 'other');
export const safeNetError = (text) => (typeof text === 'string' && text ? (NET_ERRORS.has(text) ? text : OTHER_NET_ERROR) : null);
export const safeReadyState = (s) => (typeof s === 'string' && DOC_READY_STATES.has(s) ? s : '?');
export const OTHER_NAME = 'Other';
export const OTHER_CODE = 'OTHER';
export const safeErrorName = (name) => (typeof name === 'string' && ERROR_NAMES.has(name) ? name : OTHER_NAME);
export const safeErrorCode = (code) => (typeof code === 'string' && ERROR_CODES.has(code) ? code : OTHER_CODE);
const MAX_ROUTE_LEN = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pathname only (no query · fragment · origin · user info) with id- or token-looking segments replaced; always a string starting with «/», at most 120 chars. */
export function normalizeRoute(input) {
  let p = String(input ?? '');
  // a non-hierarchical URL (data: · blob: · javascript: · about: · mailto: …) has no «path» — its body can be anything, so it is not kept at all
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\/\/)/i.exec(p);
  if (scheme && !p.startsWith('/')) return `/(${scheme[1].toLowerCase().slice(0, 12)})`;
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // an absolute URL → its path (drops scheme · user info · host · port)
  p = p.replace(/^\/\/[^/]*/, ''); // a protocol-relative URL («//user:pass@host/path») → its path (drops user info · host · port)
  p = p.split(/[?#]/)[0] ?? '';
  const segments = p.split('/').map((seg) => {
    if (!seg) return seg;
    if (UUID.test(seg) || /^[0-9a-f]{12,}$/i.test(seg) || /^\d{4,}$/.test(seg)) return SEGMENT_ID;
    if (seg.length >= 20 && /^[A-Za-z0-9_.~%+=-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return SEGMENT_ID; // a token-looking run
    if (!/^[A-Za-z0-9_.~%@()[\]{}:+,;=!$&'*-]*$/.test(seg)) return SEGMENT_ID; // anything with an odd character is not a route name
    return seg;
  });
  p = segments.join('/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > MAX_ROUTE_LEN ? `${p.slice(0, MAX_ROUTE_LEN)}…` : p;
}

const toMs = (n, unit) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(unit === 's' ? v * 1000 : v);
};
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const SUBTIMINGS = ['compile', 'render', 'next.js', 'proxy.ts', 'application-code'];

/**
 * One raw output line → an allowlisted record, or null (dropped). The record has ONLY these keys: kind, and per kind: method/route/status/ms/parts · phase/route/ms · ms · name · code.
 */
export function parseServerLine(raw) {
  const text = String(raw ?? '').replace(ANSI, '').trim();
  if (!text) return null;
  let m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})\s+in\s+([\d.]+)\s*(ms|s)\b(.*)$/.exec(text);
  if (m) {
    const parts = {};
    const tail = m[6] ?? '';
    for (const name of SUBTIMINGS) {
      const t = new RegExp(`(?:^|[(,\\s])${name.replace(/\./g, '\\.')}:\\s*([\\d.]+)\\s*(ms|s)\\b`).exec(tail);
      if (t) { const ms = toMs(t[1], t[2]); if (ms != null) parts[name] = ms; }
    }
    return { kind: 'request', method: m[1], route: normalizeRoute(m[2]), status: Number(m[3]), ms: toMs(m[4], m[5]), parts };
  }
  m = /^[✓○◐◓◑◒]?\s*(Compiled|Compiling)\s+(\S+)(?:\s+in\s+([\d.]+)\s*(ms|s))?/.exec(text);
  if (m) return { kind: 'compile', phase: m[1] === 'Compiled' ? 'compiled' : 'compiling', route: normalizeRoute(m[2]), ms: m[3] ? toMs(m[3], m[4]) : null };
  m = /\bReady in\s+([\d.]+)\s*(ms|s)\b/.exec(text);
  if (m) return { kind: 'ready', ms: toMs(m[1], m[2]) };
  m = /^⨯\s+([A-Za-z][A-Za-z0-9_]{0,40})\b/.exec(text);
  if (m) return { kind: 'error', name: safeErrorName(m[1]) };
  m = /^code:\s*'([A-Z][A-Z0-9_]{1,40})'/.exec(text);
  if (m) return { kind: 'error-code', code: safeErrorCode(m[1]) };
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

/**
 * Rebuild a record from ONLY the allowed fields (type-checked) — the writer and the reader both go through this, so a file that someone (or an older wrapper) filled with anything else still yields nothing but these fields.
 * Returns null for an unknown kind or a value of the wrong shape.
 */
export function pickAllowed(rec) {
  if (!rec || typeof rec !== 'object') return null;
  switch (rec.kind) {
    case 'request': {
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(rec.method) || typeof rec.route !== 'string') return null;
      const parts = {};
      for (const name of SUBTIMINGS) { const v = num(rec.parts?.[name]); if (v != null) parts[name] = v; }
      return { kind: 'request', method: rec.method, route: normalizeRoute(rec.route), status: num(rec.status), ms: num(rec.ms), parts };
    }
    case 'compile':
      if ((rec.phase !== 'compiled' && rec.phase !== 'compiling') || typeof rec.route !== 'string') return null;
      return { kind: 'compile', phase: rec.phase, route: normalizeRoute(rec.route), ms: num(rec.ms) };
    case 'ready':
      return { kind: 'ready', ms: num(rec.ms) };
    case 'error':
      return typeof rec.name === 'string' ? { kind: 'error', name: safeErrorName(rec.name) } : null;
    case 'error-code':
      return typeof rec.code === 'string' ? { kind: 'error-code', code: safeErrorCode(rec.code) } : null;
    default:
      return null;
  }
}

/** The one human-readable form of a record (used on stdout, in the report). */
export function formatRecord(rec) {
  const r = pickAllowed(rec);
  if (!r) return null;
  switch (r.kind) {
    case 'request': {
      const parts = Object.entries(r.parts).map(([k, v]) => `${k}=${v}ms`).join(' ');
      return `request ${r.method} ${r.route} ${r.status ?? '?'} ${r.ms ?? '?'}ms${parts ? ` (${parts})` : ''}`;
    }
    case 'compile': return `compile ${r.phase} ${r.route}${r.ms != null ? ` ${r.ms}ms` : ''}`;
    case 'ready': return `ready ${r.ms ?? '?'}ms`;
    case 'error': return `error ${r.name}`;
    case 'error-code': return `error-code ${r.code}`;
    default: return null;
  }
}

/** a record is «slow compile related» when it names compiling · compiled or a request that carried a compile sub-timing — the lines the report counts as compile-family. */
export function isCompileFamily(rec) {
  const r = pickAllowed(rec);
  return !!r && (r.kind === 'compile' || (r.kind === 'request' && r.parts.compile != null));
}
