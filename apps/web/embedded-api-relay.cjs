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
//
// Order: this layer must sit INSIDE the Host guard (embedded-host-guard.cjs), so that the guard judges a request first (Host, cross-site, body budget) and only an admitted request reaches the relay.
// embedded-entry.cjs therefore installs this one BEFORE the guard (the guard wraps `emit` after this has wrapped it). Plain CommonJS and no dependencies.
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream');

const INSTALLED = Symbol.for('sprintable.embeddedApiRelay');
const PREFIX = '/api/v2/';

// headers of one hop (RFC 9110 7.6.1 + the ones Node sets itself); what `Connection` lists is dropped too
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * The backend URL this request is relayed to, or null (not an API request, or no usable backend address — the request then goes to Next as before).
 * The path is read the way lib/embedded-api-origin.ts reads it: the prefix in any letter case, the backend sees the canonical lower-case one; dot segments are resolved by the URL parser.
 */
function relayTarget(rawUrl, env = process.env) {
  if (typeof rawUrl !== 'string' || rawUrl[0] !== '/' || rawUrl[1] === '/') return null; // origin-form only: an absolute-form or `//host` target is not ours to read
  const origin = env['SPRINTABLE_API_ORIGIN'];
  if (!origin) return null;
  let base;
  let parsed;
  try {
    base = new URL(origin);
    parsed = new URL(rawUrl, 'http://relay.invalid');
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  if (!parsed.pathname.toLowerCase().startsWith(PREFIX)) return null;
  return new URL(`${PREFIX}${parsed.pathname.slice(PREFIX.length)}${parsed.search}`, base);
}

/** the headers to send on: no hop-by-hop ones, nothing the connection names, no `Expect` (the door has answered it), `Host` of the backend, the forwarding headers set here (a client cannot write them) */
function upstreamHeaders(req, target) {
  const named = new Set(String(req.headers['connection'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || named.has(name) || name === 'expect' || name === 'host' || name.startsWith('x-forwarded-')) continue;
    out[name] = value;
  }
  out['host'] = target.host;
  const peer = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  if (peer) out['x-forwarded-for'] = peer;
  if (req.headers['host']) out['x-forwarded-host'] = req.headers['host'];
  out['x-forwarded-proto'] = 'http';
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

module.exports = { install, relayTarget };
