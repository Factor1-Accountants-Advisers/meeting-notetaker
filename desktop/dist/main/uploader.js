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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadRecording = uploadRecording;
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const form_data_1 = __importDefault(require("form-data"));
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms
async function uploadRecording(options) {
    const { filePath, accessToken, backendUrl, metadata } = options;
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`Recording file not found: ${filePath}`);
    }
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const form = new form_data_1.default();
            form.append('audio_file', fs.createReadStream(filePath), {
                filename: path.basename(filePath),
                contentType: 'audio/wav',
            });
            form.append('metadata', JSON.stringify(metadata));
            const response = await axios_1.default.post(`${backendUrl}/api/meetings/upload`, form, {
                headers: { ...form.getHeaders(), Authorization: `Bearer ${accessToken}` },
                maxBodyLength: 600 * 1024 * 1024,
                maxContentLength: 600 * 1024 * 1024,
                timeout: 5 * 60 * 1000, // 5 minute timeout
            });
            return response.data;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const status = axios_1.default.isAxiosError(err) ? err.response?.status : undefined;
            // Don't retry client errors (4xx) — they won't succeed on retry
            if (status && status >= 400 && status < 500) {
                throw lastError;
            }
            if (attempt < MAX_RETRIES) {
                console.warn(`[uploader] Attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS[attempt]}ms:`, lastError.message);
                await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
            }
        }
    }
    throw lastError;
}
//# sourceMappingURL=uploader.js.map