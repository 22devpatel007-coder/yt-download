const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { FFMPEG_PATH } = require('../config');

// ─── Resize image to 500×500 JPEG via ffmpeg ───────────────────────────────────
// 500×500 is the standard album-art resolution used by iTunes, Spotify, etc.
// Letterboxes with white padding to maintain aspect ratio without stretching.
// Cuts cover file size ~70-85% vs a raw 1280×720 YouTube thumbnail.
async function resizeCover(inputPath, outputPath) {
    await execFileAsync(FFMPEG_PATH, [
        '-y',
        '-i', inputPath,
        '-vf', 'scale=500:500:force_original_aspect_ratio=decrease,pad=500:500:(ow-iw)/2:(oh-ih)/2:white',
        '-q:v', '3',   // JPEG quality 3 — good balance of size vs visual quality
        outputPath,
    ]);
}

module.exports = { resizeCover };
