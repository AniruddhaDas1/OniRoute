import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { app } from './app.mjs';

const PORT = Number(process.env.PORT || 1001);
const HOST = process.env.HOST || '0.0.0.0';
const DIST_DIR = join(process.cwd(), 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function tryServeStatic(urlPath, res) {
  if (!existsSync(DIST_DIR)) return false;

  const cleanPath = urlPath.split('?')[0];
  let filePath = join(DIST_DIR, cleanPath);

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
    res.end(readFileSync(filePath));
    return true;
  }

  // SPA Fallback for client routes
  const indexPath = join(DIST_DIR, 'index.html');
  if (existsSync(indexPath)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(readFileSync(indexPath));
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const url = `${protocol}://${req.headers.host || `localhost:${PORT}`}${req.url}`;
  const path = req.url.split('?')[0];

  // If this is a static asset or SPA route and NOT an API route, try serving static
  const isApiRoute =
    path.startsWith('/v1/') ||
    path === '/chat' ||
    path === '/health' ||
    path.startsWith('/providers') ||
    path.startsWith('/routing-config') ||
    path.startsWith('/knowledge') ||
    path.startsWith('/logs') ||
    path.startsWith('/gateway-keys') ||
    path.startsWith('/test-provider');

  if (!isApiRoute && req.method === 'GET') {
    if (tryServeStatic(req.url, res)) {
      return;
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      } else {
        headers.set(key, value);
      }
    }
  }

  let body = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  const webRequest = new Request(url, {
    method: req.method,
    headers,
    body,
  });

  try {
    const webResponse = await app.fetch(webRequest);

    // If 404 and not an API route, try SPA fallback
    if (webResponse.status === 404 && !isApiRoute && req.method === 'GET') {
      if (tryServeStatic(req.url, res)) return;
    }

    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, HOST, () => {
  const distReady = existsSync(DIST_DIR);
  console.log('====================================================');
  console.log(`  🚀 OniRoute Permanent Fullstack Server Running!`);
  console.log(`  📡 Web Dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  🤖 OpenAI API:    http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/v1/chat/completions`);
  console.log(`  📊 Health Check:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/health`);
  if (!distReady) {
    console.log(`  ℹ️  Note: Run 'npm run build' to bundle UI for single-port serving,`);
    console.log(`     or run 'npm run dev' in another terminal for live HMR.`);
  }
  console.log('====================================================');
});
