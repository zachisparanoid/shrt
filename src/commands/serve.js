/** Run / manage the local redirect server. */

import { openSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, listen, ServerError } from '../server.js';
import { EXIT } from '../constants.js';

function writePidFile(pidPath, pid, port) {
  writeFileSync(pidPath, `${pid}\n${port}\n`);
}
function readPidFile(pidPath) {
  try {
    const [p, port] = readFileSync(pidPath, 'utf8').trim().split(/\s+/);
    const pid = Number(p);
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, port: Number(port) || null };
  } catch {
    return { pid: null, port: null };
  }
}
function removePidFile(pidPath) {
  try {
    unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours
  }
}

function serveStatus(ctx, pidPath) {
  const { pid, port } = readPidFile(pidPath);
  const running = pid && isAlive(pid);
  if (!running && pid) removePidFile(pidPath); // clean up stale pid
  if (ctx.json) {
    ctx.outLine(JSON.stringify({ running: Boolean(running), pid: running ? pid : null, port: running ? port : null }, null, 2));
  } else if (running) {
    ctx.ok(`shrt server running (pid ${pid}${port ? `, port ${port}` : ''})`);
  } else {
    ctx.note('shrt server is not running');
  }
  return EXIT.OK;
}

function serveStop(ctx, pidPath) {
  const { pid } = readPidFile(pidPath);
  if (!pid || !isAlive(pid)) {
    removePidFile(pidPath);
    ctx.note('shrt server is not running');
    return EXIT.OK;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    ctx.fail(`failed to stop pid ${pid}: ${err.message}`);
    return EXIT.SOFTWARE;
  }
  removePidFile(pidPath);
  ctx.ok(`stopped shrt server (pid ${pid})`);
  return EXIT.OK;
}

function serveDaemon(ctx, { port, host, pidPath, logPath }) {
  if (!existsSync(ctx.paths.configDir)) mkdirSync(ctx.paths.configDir, { recursive: true });
  const { pid: existing } = readPidFile(pidPath);
  if (existing && isAlive(existing)) {
    ctx.warn(`shrt server already running (pid ${existing}); use 'shrt serve --stop' first`);
    return EXIT.OK;
  }
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [process.argv[1], 'serve', '--port', String(port), '--host', host], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  writePidFile(pidPath, child.pid, port);
  child.unref();
  ctx.ok(`shrt server started in background (pid ${child.pid}) on http://${host}:${port}`);
  ctx.note(`logs → ${logPath}`);
  return EXIT.OK;
}

async function serveForeground(ctx, { port, host, pidPath }) {
  const db = ctx.getDb(); // also ensures the config dir exists
  const c = ctx.colors;
  const log = (msg) => ctx.outLine(`${c ? c.dim(new Date().toISOString()) : new Date().toISOString()} ${msg}`);
  const server = createServer({ db, config: ctx.config, log });

  let addr;
  try {
    addr = await listen(server, { port, host });
  } catch (err) {
    if (err instanceof ServerError && err.code === 'EADDRINUSE') {
      const { pid } = readPidFile(pidPath);
      ctx.fail(`port ${port} is already in use${pid && isAlive(pid) ? ` (pid ${pid})` : ''}`);
      return EXIT.TEMPFAIL;
    }
    ctx.fail(`failed to start server: ${err.message}`);
    return EXIT.SOFTWARE;
  }

  writePidFile(pidPath, process.pid, addr.port);
  ctx.ok(`shrt server listening on ${c ? c.cyan(`http://${host}:${addr.port}`) : `http://${host}:${addr.port}`}`);
  ctx.note('press Ctrl+C to stop');

  return await new Promise((resolve) => {
    let shuttingDown = false;
    const shutdown = (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;
      ctx.errLine('');
      ctx.note(`received ${sig}, shutting down…`);
      const finish = () => {
        removePidFile(pidPath);
        resolve(EXIT.OK);
      };
      server.close(finish);
      const t = setTimeout(finish, 3000); // force-resolve if connections hang
      t.unref?.();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}

/**
 * @param {object} ctx
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function serveCommand(ctx, cmdOpts = {}) {
  // port 0 = let the OS pick a free ephemeral port (the bound port is printed).
  const port = cmdOpts.port != null ? Number(cmdOpts.port) : ctx.config.serverPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    ctx.fail(`invalid port: ${cmdOpts.port}`);
    return EXIT.USAGE;
  }
  const host = cmdOpts.host || '127.0.0.1';
  const { pidPath, logPath } = ctx.paths;

  if (cmdOpts.status) return serveStatus(ctx, pidPath);
  if (cmdOpts.stop) return serveStop(ctx, pidPath);
  if (cmdOpts.daemon) return serveDaemon(ctx, { port, host, pidPath, logPath });
  return serveForeground(ctx, { port, host, pidPath });
}
