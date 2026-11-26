import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const APP_FINGERPRINT = /__APP_CONFIG__/;
const DEVTOOLS_FINGERPRINT = /remote debugging/i;

export function createPortDiscovery({
  pinnedPort = 0,
  logPaths = [],
  probeTimeoutMs = 1500,
  cacheTtlMs = 8000,
} = {}) {
  let cachedPort = 0;
  let cachedAt = 0;

  function liveLocalPorts() {
    const ports = [];
    try {
      const out = execFileSync('ss', ['-ltnpH'], {
        encoding: 'utf-8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        if (!line.includes('language_server')) continue;
        const fields = line.trim().split(/\s+/);
        const localAddr = fields[3] || '';
        const match = localAddr.match(/:(\d+)$/);
        if (match) {
          const port = Number(match[1]);
          if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      }
    } catch {
      // ss may be unavailable or restricted; fall back to pinned/log candidates
    }
    return ports;
  }

  function logPortCandidates() {
    const ports = [];
    const existingLogs = logPaths
      .filter((p) => {
        try {
          return Boolean(p) && fs.existsSync(p);
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });

    for (const logPath of existingLogs) {
      try {
        const content = fs.readFileSync(logPath, 'latin1');
        const matches = [
          ...content.matchAll(/Language server listening on \w+ port at (\d+) for HTTP\b/gi),
        ];
        for (let i = matches.length - 1; i >= 0; i -= 1) {
          const port = Number(matches[i][1]);
          if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) {
            ports.push(port);
          }
        }
      } catch {
        // ignore unreadable logs
      }
    }
    return ports;
  }

  function buildCandidates() {
    const ordered = [];
    const sources = [
      ...(pinnedPort > 0 ? [pinnedPort] : []),
      ...liveLocalPorts(),
      ...logPortCandidates(),
    ];
    for (const p of sources) {
      if (Number.isInteger(p) && p > 0 && p < 65536 && !ordered.includes(p)) {
        ordered.push(p);
      }
    }
    return ordered;
  }

  function probePort(port) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        try {
          req.destroy();
        } catch {
          // ignore
        }
        resolve(result);
      };

      const describe = (status, body) => ({
        reachable: true,
        status,
        servesAppUi: status === 200 && APP_FINGERPRINT.test(body),
        looksLikeDevTools: DEVTOOLS_FINGERPRINT.test(body),
      });

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'GET',
          headers: { host: `127.0.0.1:${port}`, connection: 'close' },
          timeout: probeTimeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            if (size < 8192) {
              chunks.push(chunk);
              size += chunk.length;
            }
            if (size >= 8192) {
              done(describe(res.statusCode, Buffer.concat(chunks).toString('latin1')));
            }
          });
          res.on('end', () => done(describe(res.statusCode, Buffer.concat(chunks).toString('latin1'))));
          res.on('error', () => done(describe(res.statusCode, Buffer.concat(chunks).toString('latin1'))));
        }
      );

      req.on('timeout', () => done({ reachable: false }));
      req.on('error', () => done({ reachable: false }));
      req.end();
    });
  }

  function isPortOpen(port, timeoutMs = 500) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
    });
  }

  async function discover(force = false) {
    const now = Date.now();
    if (!force && cachedPort > 0) {
      if (now - cachedAt < cacheTtlMs) {
        return cachedPort;
      }
      if (await isPortOpen(cachedPort)) {
        cachedAt = Date.now();
        return cachedPort;
      }
    }

    // Fast path: if a dedicated port is pinned, verify it first without probing unrelated ports.
    if (pinnedPort > 0) {
      const pinnedProbe = await probePort(pinnedPort);
      if (pinnedProbe.servesAppUi || (pinnedProbe.reachable && pinnedProbe.status === 200 && !pinnedProbe.looksLikeDevTools)) {
        if (cachedPort !== pinnedPort) {
          console.log(`[agy-web-gateway] backend port resolved (pinned) -> 127.0.0.1:${pinnedPort}`);
        }
        cachedPort = pinnedPort;
        cachedAt = Date.now();
        return cachedPort;
      }
    }

    const candidates = buildCandidates();
    const probes = await Promise.all(
      candidates.map(async (port) => ({ port, result: await probePort(port) }))
    );

    const appUi = probes.find((p) => p.result.servesAppUi);
    const plain200 = probes.find(
      (p) => p.result.reachable && p.result.status === 200 && !p.result.looksLikeDevTools
    );
    const reachable = probes.find((p) => p.result.reachable && !p.result.looksLikeDevTools);
    const chosen = (
      appUi ||
      plain200 ||
      reachable ||
      probes.find((p) => p.port === pinnedPort) ||
      probes[0] ||
      {}
    ).port;

    if (chosen && chosen !== cachedPort) {
      console.log(
        `[agy-web-gateway] backend port resolved -> 127.0.0.1:${chosen} (candidates: ${candidates.join(', ') || 'none'})`
      );
    }

    cachedPort = chosen || 0;
    cachedAt = Date.now();
    return cachedPort;
  }

  function invalidate() {
    cachedPort = 0;
    cachedAt = 0;
  }

  async function inspect() {
    const localPorts = liveLocalPorts();
    const logPorts = logPortCandidates();
    const candidates = buildCandidates();
    const probes = await Promise.all(
      candidates.map(async (port) => ({ port, result: await probePort(port) }))
    );
    return {
      pinnedPort: pinnedPort || null,
      activeBackendPort: cachedPort || null,
      localLanguageServerPorts: localPorts,
      logDerivedPorts: logPorts,
      candidates,
      probes,
    };
  }

  return {
    discover,
    invalidate,
    inspect,
    getCachedPort: () => cachedPort,
  };
}
