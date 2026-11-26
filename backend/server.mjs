import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortDiscovery } from './port_discovery.mjs';
import { createAppStorage } from './storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const HOME = os.homedir();

const LISTEN_HOST = process.env.AGY_WEB_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.AGY_WEB_PORT || 13081);
const PROFILE_ROOT = process.env.AGY_PROFILE_ROOT || path.join(HOME, '.config', 'agy-headless');
const DEFAULT_WORKSPACE = process.env.AGY_DEFAULT_WORKSPACE || path.join(HOME, 'for_antigravity');
const PINNED_BACKEND_PORT = Number(process.env.AGY_BACKEND_HTTP_PORT || process.env.AGY_LS_HTTP_PORT || 0);

const LOG_PATHS = [
  process.env.AGY_LS_LOG_PATH,
  path.join(PROFILE_ROOT, 'Antigravity', 'logs', 'language_server.log'),
  path.join(HOME, '.config', 'Antigravity', 'logs', 'language_server.log'),
].filter(Boolean);

const STORAGE_PATH =
  process.env.AGY_APP_STORAGE_PATH ||
  path.join(PROFILE_ROOT, 'Antigravity', 'app_storage.json');

const startedAt = Date.now();
const storage = createAppStorage(STORAGE_PATH);
const portDiscovery = createPortDiscovery({
  pinnedPort: PINNED_BACKEND_PORT,
  logPaths: LOG_PATHS,
  probeTimeoutMs: Number(process.env.AGY_PROBE_TIMEOUT_MS || 1500),
  cacheTtlMs: Number(process.env.AGY_PORT_CACHE_TTL_MS || 8000),
});

function readFrontendTemplate(filename) {
  return fs.readFileSync(path.join(FRONTEND_DIR, filename), 'utf-8');
}

function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

function buildInjectedHeadScript() {
  const rawShim = readFrontendTemplate('web_shim.js');
  const populated = rawShim
    .replace('__INITIAL_APP_STORAGE__', safeJsonForScript(storage.read()))
    .replace('__DEFAULT_WORKSPACE__', safeJsonForScript(DEFAULT_WORKSPACE));
  return `<script>\n${populated}\n</script>`;
}

function buildSidecarPatchScript(sidecarPort) {
  const prefix = `/__agy_sidecar/${sidecarPort}`;
  const rawPatch = readFrontendTemplate('sidecar_patch.js');
  const populated = rawPatch.replace('__SIDECAR_PREFIX__', safeJsonForScript(prefix));
  return `<script>\n${populated}\n</script>`;
}

function proxySidecarRequest(req, res, sidecarPort, rawTail) {
  let upstreamPath = rawTail || '/';
  if (!upstreamPath.startsWith('/')) upstreamPath = '/' + upstreamPath;

  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${sidecarPort}`;

  const isAsset = /\.(js|mjs|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|mp3|ogg|wav|wasm|map)(\?|$)/i.test(
    upstreamPath
  );
  const isApi =
    upstreamPath.startsWith('/api/') ||
    upstreamPath.startsWith('/_sidecar/') ||
    req.method !== 'GET';

  if (!isAsset && !isApi) {
    delete headers['accept-encoding'];
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: sidecarPort,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const prefix = `/__agy_sidecar/${sidecarPort}`;
      const contentType = String(proxyRes.headers['content-type'] || '');
      const outHeaders = { ...proxyRes.headers };
      delete outHeaders['x-frame-options'];

      if (typeof outHeaders.location === 'string' && outHeaders.location.startsWith('/') && !outHeaders.location.startsWith(prefix)) {
        outHeaders.location = `${prefix}${outHeaders.location}`;
      }

      if (!isAsset && !isApi && contentType.includes('text/html')) {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');
          html = html.replace(
            /(src|href)=(["'])\/(?!\/|__agy_sidecar\/)/gi,
            `$1=$2${prefix}/`
          );
          const patchScript = buildSidecarPatchScript(sidecarPort);
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${patchScript}`);
          } else {
            html = `${patchScript}\n${html}`;
          }
          delete outHeaders['content-length'];
          delete outHeaders['content-security-policy'];
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          res.end(html, 'utf-8');
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `Antigravity Web Gateway (107): Failed to reach sidecar on 127.0.0.1:${sidecarPort} (${err.message})`
    );
  });

  req.pipe(proxyReq);
}

async function handleHealthEndpoint(res) {
  const details = await portDiscovery.inspect();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify(
      {
        service: 'agy-web-gateway-107',
        user: os.userInfo().username,
        host: os.hostname(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        listening: { host: LISTEN_HOST, port: LISTEN_PORT },
        profileRoot: PROFILE_ROOT,
        storagePath: storage.path,
        defaultWorkspace: DEFAULT_WORKSPACE,
        ...details,
      },
      null,
      2
    )
  );
}

const server = http.createServer(async (req, res) => {
  const reqUrl = req.url || '/';

  // 1. Gateway status & maintenance UI
  if (reqUrl === '/__agy_gateway_ui' || reqUrl === '/__agy_gateway_ui/') {
    try {
      const html = readFrontendTemplate('dashboard.html');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html, 'utf-8');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load dashboard.html: ${err.message}`);
    }
    return;
  }

  // 2. Gateway JSON health endpoint
  if (reqUrl === '/__agy_gateway_health') {
    await handleHealthEndpoint(res);
    return;
  }

  // 3. Force immediate backend port rediscovery
  if (reqUrl === '/__agy_gateway_rediscover' && req.method === 'POST') {
    portDiscovery.invalidate();
    const resolved = await portDiscovery.discover(true);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ok: Boolean(resolved), backendPort: resolved || null }));
    return;
  }

  // 4. Sidecar proxy route: /__agy_sidecar/<port>/<path>
  const sidecarMatch = reqUrl.match(/^\/__agy_sidecar\/(\d+)(\/.*|\?.*|$)/);
  if (sidecarMatch) {
    const sidecarPort = Number(sidecarMatch[1]);
    if (sidecarPort >= 1024 && sidecarPort <= 65535) {
      proxySidecarRequest(req, res, sidecarPort, sidecarMatch[2] || '/');
      return;
    }
  }

  // 5. Local storage sync endpoint
  if (reqUrl === '/__agy_gateway_storage') {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(storage.read()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        if (body.length < 2 * 1024 * 1024) body += chunk;
      });
      req.on('end', () => {
        let ok = false;
        try {
          ok = storage.update(JSON.parse(body || '{}'));
        } catch {
          ok = false;
        }
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      });
      return;
    }
  }

  // 6. Reverse proxy to Antigravity language_server HTTP UI + ConnectRPC
  const backendPort = await portDiscovery.discover();
  if (!backendPort) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'Antigravity Web Gateway (107): No reachable language_server backend found. Open /__agy_gateway_ui for diagnostics.'
    );
    return;
  }

  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${backendPort}`;

  const isAsset = /\.(js|mjs|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|mp3|ogg|wav|wasm|map)(\?|$)/i.test(
    reqUrl
  );
  const isRpc = reqUrl.startsWith('/exa.') || req.method === 'POST';
  if (!isAsset && !isRpc) {
    delete headers['accept-encoding'];
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: backendPort,
      path: reqUrl,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] || '');
      if (!isAsset && !isRpc && contentType.includes('text/html')) {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');
          // Strip Google preconnect tags that stall browsers without an outbound proxy
          html = html.replace(/<link\s+rel="preconnect"[^>]*>/gi, '');
          const headScript = buildInjectedHeadScript();
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${headScript}`);
          } else {
            html = `${headScript}\n${html}`;
          }
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['content-security-policy'];
          res.writeHead(proxyRes.statusCode || 200, outHeaders);
          res.end(html, 'utf-8');
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on('error', (err) => {
    portDiscovery.invalidate();
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `Antigravity Web Gateway (107): Failed to reach language_server on 127.0.0.1:${backendPort} (${err.message}).\nCheck /__agy_gateway_ui for live diagnostics.`
    );
  });

  req.pipe(proxyReq);
});

// Tunnel WebSocket upgrades (/connect-websocket, /voice/ws, /__agy_sidecar/<port>/...)
server.on('upgrade', async (req, socket, head) => {
  const reqUrl = req.url || '/';
  const sidecarMatch = reqUrl.match(/^\/__agy_sidecar\/(\d+)(\/.*|\?.*|$)/);

  let targetPort = 0;
  let targetUrl = reqUrl;
  if (sidecarMatch) {
    targetPort = Number(sidecarMatch[1]);
    targetUrl = sidecarMatch[2] || '/';
    if (!targetUrl.startsWith('/')) targetUrl = '/' + targetUrl;
  } else {
    targetPort = await portDiscovery.discover();
  }

  if (!targetPort || targetPort < 1024 || targetPort > 65535) {
    socket.destroy();
    return;
  }

  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    let reqLines = `${req.method} ${targetUrl} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = k.toLowerCase() === 'host' ? `127.0.0.1:${targetPort}` : req.rawHeaders[i + 1];
      reqLines += `${k}: ${v}\r\n`;
    }
    reqLines += '\r\n';
    upstream.write(reqLines);
    if (head && head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', () => {
    if (!sidecarMatch) portDiscovery.invalidate();
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, async () => {
  const backendPort = await portDiscovery.discover(true);
  console.log(
    `[agy-web-gateway] (${os.userInfo().username}@${os.hostname()}) Listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> backend 127.0.0.1:${backendPort || 'pending'}`
  );
  console.log(`[agy-web-gateway] Status UI: http://${LISTEN_HOST}:${LISTEN_PORT}/__agy_gateway_ui`);
});
