/**
 * The local redirect server. Tiny, dependency-free (Node's http only).
 *
 * Routes:
 *   GET  /healthz     → 200 "ok"
 *   GET  /            → minimal status page (link count + uptime)
 *   GET  /robots.txt  → disallow all (short links shouldn't be crawled)
 *   GET  /:code       → 302 to long_url, increments hits
 *   HEAD /:code       → 302 to long_url, does NOT increment
 *   *                 → 404
 */

import http from 'node:http';
import { recordHit, getByCode, countLinks } from './db.js';
import { VERSION } from './version.js';

/** Thrown when the server cannot bind. */
export class ServerError extends Error {
  /** @param {string} message @param {{ code?: string, port?: number }} [opts] */
  constructor(message, { code, port } = {}) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.port = port;
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function nowIso(ctx) {
  const ms = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  return new Date(ms).toISOString();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function notFound(res, code) {
  const html = `<!doctype html><meta charset="utf-8"><title>404 · shrt</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">
<h1>404</h1><p>No short link for <code>/${esc(code)}</code>.</p></body>`;
  send(res, 404, html, { 'content-type': 'text/html; charset=utf-8' });
}

function statusPage(res, ctx) {
  const total = countLinks(ctx.db);
  const uptimeS = ctx.startedAt ? Math.round((Date.now() - ctx.startedAt) / 1000) : 0;
  const html = `<!doctype html><meta charset="utf-8"><title>shrt</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>shrt <small style="color:#888">v${esc(VERSION)}</small></h1>
<p><strong>${total}</strong> link${total === 1 ? '' : 's'} · uptime ${uptimeS}s</p>
<p style="color:#888">Self-hosted URL shortener. Visit <code>/&lt;code&gt;</code> to be redirected.</p>
</body>`;
  send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
}

/**
 * Build the (req, res) handler.
 * @param {{ db: any, config?: object, now?: () => number, log?: (msg: string) => void, startedAt?: number }} ctx
 */
export function createRequestHandler(ctx) {
  return function handler(req, res) {
    const method = req.method || 'GET';
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      pathname = req.url || '/';
    }
    const code = pathname.replace(/^\/+/, '');

    const log = (status, extra = '') => ctx.log?.(`${method} ${pathname} → ${status}${extra ? ' ' + extra : ''}`);

    // Health / status / robots / favicon — handled before code lookup.
    if (pathname === '/healthz') {
      send(res, 200, 'ok');
      return log(200);
    }
    if (pathname === '/robots.txt') {
      send(res, 200, 'User-agent: *\nDisallow: /\n');
      return log(200);
    }
    if (pathname === '/favicon.ico') {
      send(res, 204, '');
      return log(204);
    }
    if (pathname === '/') {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'method not allowed');
        return log(405);
      }
      statusPage(res, ctx);
      return log(200);
    }

    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'method not allowed');
      return log(405);
    }

    // Look up the code. GET counts a hit; HEAD does not.
    const row = method === 'GET' ? recordHit(ctx.db, code, nowIso(ctx)) : getByCode(ctx.db, code);
    if (!row) {
      notFound(res, code);
      return log(404);
    }
    res.writeHead(302, {
      location: row.long_url,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>redirecting…</title>
<p>Redirecting to <a href="${esc(row.long_url)}">${esc(row.long_url)}</a></p>`);
    log(302, `→ ${row.long_url}`);
  };
}

/** Create (but do not start) an http.Server. */
export function createServer(ctx) {
  const withStart = { startedAt: Date.now(), ...ctx };
  return http.createServer(createRequestHandler(withStart));
}

/**
 * Start listening. Resolves with the bound address, rejects with ServerError.
 * @param {http.Server} server
 * @param {{ port: number, host?: string }} opts
 * @returns {Promise<{ port: number, address: string }>}
 */
export function listen(server, { port, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new ServerError(`port ${port} is already in use`, { code: 'EADDRINUSE', port }));
      } else {
        reject(new ServerError(err.message, { code: err.code, port }));
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}
