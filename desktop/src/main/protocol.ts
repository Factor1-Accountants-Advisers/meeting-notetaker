import { protocol, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let _registered = false;

export function registerAppProtocol(staticDir: string, backendUrl: string): void {
  // Guard: protocol can only be registered once
  if (_registered) return;
  _registered = true;

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);

    // Proxy API requests to the backend
    if (url.pathname.startsWith('/api/')) {
      const backendTarget = `${backendUrl}${url.pathname}${url.search}`;
      const fetchOptions: Record<string, unknown> = {
        method: request.method,
        headers: request.headers,
        body: request.body,
      };
      if (request.body) {
        fetchOptions.duplex = 'half';
      }
      return net.fetch(backendTarget, fetchOptions);
    }

    // Serve static files (async reads to avoid blocking main process)
    let filePath = path.join(staticDir, url.pathname);

    // SPA fallback: if file doesn't exist, serve index.html
    const exists = fsSync.existsSync(filePath);
    if (!exists || fsSync.statSync(filePath).isDirectory()) {
      if (fsSync.existsSync(filePath + '.html')) {
        filePath = filePath + '.html';
      } else if (fsSync.existsSync(path.join(filePath, 'index.html'))) {
        filePath = path.join(filePath, 'index.html');
      } else {
        filePath = path.join(staticDir, 'index.html');
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const data = await fs.readFile(filePath);
      return new Response(data, {
        headers: { 'Content-Type': mimeType },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
