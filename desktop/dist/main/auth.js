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
exports.acquireToken = acquireToken;
exports.acquireIdToken = acquireIdToken;
exports.clearTokenCache = clearTokenCache;
const msal_node_1 = require("@azure/msal-node");
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CACHE_FILE = path.join(electron_1.app.getPath('userData'), 'msal-cache.enc');
const SCOPES = [
    'https://graph.microsoft.com/Calendars.Read',
    'https://graph.microsoft.com/User.Read',
];
const ID_SCOPES = ['openid', 'profile', 'User.Read'];
function buildPca() {
    const clientId = process.env.AZURE_AD_CLIENT_ID;
    const tenantId = process.env.AZURE_AD_TENANT_ID;
    if (!clientId || !tenantId)
        throw new Error('AZURE_AD_CLIENT_ID and AZURE_AD_TENANT_ID must be set');
    return new msal_node_1.PublicClientApplication({
        auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
        system: {
            loggerOptions: { loggerCallback: () => { }, piiLoggingEnabled: false, logLevel: msal_node_1.LogLevel.Warning },
        },
    });
}
let _pca = null;
function getPca() {
    if (!_pca)
        _pca = buildPca();
    return _pca;
}
function loadCache(pca) {
    try {
        if (!fs.existsSync(CACHE_FILE))
            return;
        const encrypted = fs.readFileSync(CACHE_FILE);
        const data = electron_1.safeStorage.decryptString(encrypted);
        pca.getTokenCache().deserialize(data);
    }
    catch {
        // Cache corrupt or unreadable — start fresh
    }
}
function saveCache(pca) {
    const serialized = pca.getTokenCache().serialize();
    const encrypted = electron_1.safeStorage.encryptString(serialized);
    fs.writeFileSync(CACHE_FILE, encrypted);
}
async function acquireToken() {
    const pca = getPca();
    loadCache(pca);
    const accounts = await pca.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
        try {
            const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: SCOPES });
            if (result?.accessToken) {
                saveCache(pca);
                return result.accessToken;
            }
            console.warn('[auth] silent token resolved but returned no accessToken; falling back to device code');
        }
        catch (err) {
            console.warn('[auth] silent acquisition failed, falling back to device code:', err);
        }
    }
    console.log('[auth] Silent acquisition failed — starting device code flow for Graph API scopes...');
    const result = await pca.acquireTokenByDeviceCode({
        scopes: SCOPES,
        deviceCodeCallback: (r) => {
            console.log('='.repeat(60));
            console.log('[auth] DEVICE CODE:', r.message);
            console.log('='.repeat(60));
        },
    });
    if (!result?.accessToken)
        throw new Error('Token acquisition failed');
    saveCache(pca);
    return result.accessToken;
}
async function acquireIdToken() {
    const pca = getPca();
    loadCache(pca);
    const accounts = await pca.getTokenCache().getAllAccounts();
    if (accounts.length > 0) {
        try {
            const result = await pca.acquireTokenSilent({ account: accounts[0], scopes: ID_SCOPES });
            if (result?.idToken) {
                saveCache(pca);
                return result.idToken;
            }
        }
        catch { /* fall through */ }
    }
    const result = await pca.acquireTokenByDeviceCode({
        scopes: ID_SCOPES,
        deviceCodeCallback: (r) => console.log(r.message),
    });
    if (!result?.idToken)
        throw new Error('Id token acquisition failed');
    saveCache(pca);
    return result.idToken;
}
async function clearTokenCache() {
    try {
        fs.unlinkSync(CACHE_FILE);
    }
    catch { /* ignore */ }
    _pca = null;
}
//# sourceMappingURL=auth.js.map