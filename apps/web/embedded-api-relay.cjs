'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS on purpose: copied next to Next's standalone server.js and run by the app without a build step */
// story 4844 — inside the desktop app's own web server `/api/v2/*` is handed to the app's backend HERE, at the http server's door, with Node's http — not by Next's rewrite.
//
// Why: Next 16.2.2's proxy (a config rewrite, or the middleware rewrite the embedded server used: lib/embedded-api-origin.ts) ends the client's response when the upstream response
// ENDS, but when the upstream is CUT in the middle of a response (the backend restarted or crashed, a reset) it never ends the client's response — the client waits for ever and the
// server holds the request (measured, story 4843: 20 of 20 left open, `head sent · live`, with a config rewrite, with a middleware rewrite, and with a route handler streaming a fetch body).
// On the hosted stack that was the memory leak behind the prod VM stop of 2026-11-04. In the app it happens whenever the backend inside it restarts: a local agent's stream (`GET /api/v2/agent/stream`)
// is then left open for ever instead of ending, so that the agent's client reconnects.
//
// What it does: a request whose path is `/api/v2/…` (any letter case, as lib/embedded-api-origin.ts) is relayed to `SPRINTABLE_API_ORIGIN` (read when the request arrives) and is NOT passed on to
// Next. The upstream response is piped back as it arrives (no buffering, no compression). If the upstream is cut, the client's connection is closed; if the client goes away, the upstream request is
// closed. Anything else — and every request while there is no usable `SPRINTABLE_API_ORIGIN` — goes to Next exactly as before.
// story 5024 (AC5): `/mcp` (and below) is relayed the same way to the MCP door (`SPRINTABLE_MCP_ORIGIN`) — set by the supervisor only while a server host's public door is open — so an agent on ANOTHER computer reaches its tools at `<public address>/mcp` through the same TLS front, with no second port.
//
// Order: this layer must sit INSIDE the Host guard (embedded-host-guard.cjs), so that the guard judges a request first (Host, cross-site, body budget) and only an admitted request reaches the relay.
// embedded-entry.cjs therefore installs this one BEFORE the guard (the guard wraps `emit` after this has wrapped it). Plain CommonJS and no dependencies.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { pipeline } = require('node:stream');

const INSTALLED = Symbol.for('sprintable.embeddedApiRelay');
const PREFIX = '/api/v2/';
const MCP_PATH = '/mcp';

// headers of one hop (RFC 9110 7.6.1 + the ones Node sets itself); what `Connection` lists is dropped too
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * The backend URL this request is relayed to, or null (not an API request, or no usable backend address — the request then goes to Next as before).
 * The path is read the way lib/embedded-api-origin.ts reads it: the prefix in any letter case, the backend sees the canonical lower-case one; dot segments are resolved by the URL parser.
 */
function relayTarget(rawUrl, env = process.env) {
  if (typeof rawUrl !== 'string' || rawUrl[0] !== '/' || rawUrl[1] === '/') return null; // origin-form only: an absolute-form or `//host` target is not ours to read
  let parsed;
  try {
    parsed = new URL(rawUrl, 'http://relay.invalid');
  } catch {
    return null;
  }
  // story 5024 (AC5) — the MCP door of a SERVER HOST, at the SAME name and port as everything else: an agent on another computer reaches `<public address>/mcp` through the one TLS front, with no second port to open. The path is the MCP door's own
  // (`/mcp`, or below it: exactly that spelling — not `/mcpx`, not another letter case), sent on as it is; the address it goes to is `SPRINTABLE_MCP_ORIGIN`, which the supervisor gives the web ONLY while the public door is open. Not set → `/mcp` goes to Next as before.
  if (parsed.pathname === MCP_PATH || parsed.pathname.startsWith(`${MCP_PATH}/`)) {
    const mcpBase = baseOf(env['SPRINTABLE_MCP_ORIGIN']);
    return mcpBase ? new URL(`${parsed.pathname}${parsed.search}`, mcpBase) : null;
  }
  const base = baseOf(env['SPRINTABLE_API_ORIGIN']);
  if (!base) return null;
  if (!parsed.pathname.toLowerCase().startsWith(PREFIX)) return null;
  return new URL(`${PREFIX}${parsed.pathname.slice(PREFIX.length)}${parsed.search}`, base);
}

/** a usable http(s) origin from an environment value, or null */
function baseOf(origin) {
  if (!origin) return null;
  let base;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  return base.protocol === 'http:' || base.protocol === 'https:' ? base : null;
}

/** the headers to send on: no hop-by-hop ones, nothing the connection names, no `Expect` (the door has answered it), `Host` of the backend, the forwarding headers set here (a client cannot write them) */
/**
 * story 5022 (b) — the public host (`SPRINTABLE_PUBLIC_ORIGIN`): the SAME rules as `publicHostOf` in embedded-host-guard.cjs and lib/embedded-api-origin.ts (a test holds the three together). Null → only the loopback is served.
 */
function publicHostOf(env) {
  const v = env && typeof env['SPRINTABLE_PUBLIC_ORIGIN'] === 'string' ? env['SPRINTABLE_PUBLIC_ORIGIN'] : '';
  const m = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(v);
  if (!m) return null;
  const name = m[1];
  const port = m[2];
  if (name.length > 253 || (port !== undefined && (Number(port) > 65535 || port === '443'))) return null;
  const last = name.slice(name.lastIndexOf('.') + 1);
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last) || name === 'localhost' || name.endsWith('.localhost')) return null;
  return port === undefined ? name : `${name}:${port}`;
}

/**
 * Did this request come through the server host's TLS front? Yes only when the public host is set, the connection is from THIS computer (the front runs here) and the `Host` is exactly the public name. Then — and only then — the front's own
 * `X-Forwarded-For` is the person's address: the rightmost entry (the one the front itself wrote; Caddy replaces what a client sent, and a longer chain still ends in the front's entry). Anything else: the address of the connection, as before.
 */
function throughFront(req, env) {
  const publicHost = publicHostOf(env);
  if (publicHost === null) return false;
  const peer = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') return false;
  return String(req.headers['host'] || '').toLowerCase() === publicHost;
}

function frontClientIp(req) {
  const xff = req.headers['x-forwarded-for']; // Node joins repeated lines with ", ": the last entry is the nearest hop's
  if (typeof xff !== 'string') return '';
  const last = xff.split(',').pop().trim();
  return net.isIP(last) ? last : '';
}

function upstreamHeaders(req, target, env = process.env) {
  const named = new Set(String(req.headers['connection'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || named.has(name) || name === 'expect' || name === 'host' || name.startsWith('x-forwarded-')) continue;
    out[name] = value;
  }
  out['host'] = target.host;
  const peer = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  const front = throughFront(req, env);
  const who = (front ? frontClientIp(req) : '') || peer; // story 5022 (b): behind the TLS front the person's address, not the front's own (every person would share one rate-limit bucket)
  out['x-forwarded-for'] = who || 'unknown'; // ALWAYS set (even for a connection that has no address — «unknown» is not an address, the backend then uses its socket): the backend's loopback-only routes (local-bootstrap · server-setup) refuse any request that carries a forwarded header, so nothing that comes in through here can reach them
  if (req.headers['host']) out['x-forwarded-host'] = req.headers['host'];
  out['x-forwarded-proto'] = front ? 'https' : 'http';
  return out;
}

function relay(req, res, target) {
  const lib = target.protocol === 'https:' ? https : http;
  let upstreamRes = null;
  let done = false;
  const finish = () => { done = true; };
  // `agent: false` — a fresh connection for each request: a kept-alive one to a backend that has just been restarted fails its first request with a reset
  const up = lib.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: req.method,
    headers: upstreamHeaders(req, target), agent: false,
  });
  // the client went away (closed, aborted, or the response is over): the upstream request goes too — unless the exchange finished in order
  res.once('close', () => { if (!done) { up.destroy(); if (upstreamRes) upstreamRes.destroy(); } });
  up.once('error', () => {
    // nothing came back (refused, reset before the head): a 502 while we still can; otherwise the head is out and the only honest end is a cut
    if (!res.headersSent) {
      finish();
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Connection', 'close');
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  });
  up.once('response', (r) => {
    upstreamRes = r;
    const pairs = [];
    const named = new Set(String(r.headers['connection'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
    for (let i = 0; i + 1 < r.rawHeaders.length; i += 2) {
      const name = r.rawHeaders[i];
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
      pairs.push(name, r.rawHeaders[i + 1]);
    }
    res.writeHead(r.statusCode || 502, r.statusMessage, pairs);
    res.flushHeaders();
    // the upstream response is piped as it arrives; if it is CUT (premature close, reset) the pipeline destroys the client's response — which closes its connection — instead of leaving it open
    pipeline(r, res, (err) => { if (!err) finish(); });
  });
  pipeline(req, up, () => undefined); // the request body goes on (backpressure kept); a client that dies mid-body ends the upstream request
}

/** Installs the relay on `target` (default: every http.Server) when the env says this is the app's own server. Returns whether it is installed now. Install it BEFORE the Host guard. */
function install(env = process.env, target = http.Server.prototype) {
  if (env['SPRINTABLE_EMBEDDED'] !== '1') return false;
  if (target[INSTALLED]) return true;
  const original = target.emit;
  target.emit = function relayEmit(event, ...args) {
    if (event === 'request' && args[0] && args[1]) {
      const req = args[0];
      const res = args[1];
      const to = relayTarget(req.url, process.env);
      if (to) {
        relay(req, res, to);
        return true;
      }
    }
    return original.call(this, event, ...args);
  };
  target[INSTALLED] = true;
  return true;
}

module.exports = { install, relayTarget, upstreamHeaders, publicHostOf };
