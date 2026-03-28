"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAppProtocol = registerAppProtocol;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("fs"));
const MIME_TYPES = {
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
function registerAppProtocol(staticDir, backendUrl) {
    // Guard: protocol can only be registered once
    if (_registered)
        return;
    _registered = true;
    electron_1.protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        // Proxy API requests to the backend
        if (url.pathname.startsWith('/api/')) {
            const backendTarget = `${backendUrl}${url.pathname}${url.search}`;
            return electron_1.net.fetch(backendTarget, {
                method: request.method,
                headers: request.headers,
                body: request.body,
            });
        }
        // Serve static files (async reads to avoid blocking main process)
        let filePath = path.join(staticDir, url.pathname);
        // SPA fallback: if file doesn't exist, serve index.html
        const exists = fsSync.existsSync(filePath);
        if (!exists || fsSync.statSync(filePath).isDirectory()) {
            if (fsSync.existsSync(filePath + '.html')) {
                filePath = filePath + '.html';
            }
            else if (fsSync.existsSync(path.join(filePath, 'index.html'))) {
                filePath = path.join(filePath, 'index.html');
            }
            else {
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
        }
        catch {
            return new Response('Not Found', { status: 404 });
        }
    });
}
//# sourceMappingURL=protocol.js.map