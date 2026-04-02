require('dotenv').config();
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3030;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// ─── Concurrency pool size ─────────────────────────────────────────────────────
// 3 parallel downloads is the sweet spot: ~3× faster than sequential while
// staying under YouTube's soft rate-limit. Raise via CONCURRENCY env var.
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ─── Directories ───────────────────────────────────────────────────────────────
const downloadDir = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

module.exports = {
    PORT,
    FFMPEG_PATH,
    CONCURRENCY,
    ALLOWED_ORIGIN,
    downloadDir
};
