const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const { tryUnlink } = require('../utils/fileHelper');
const { resizeCover } = require('../utils/ffmpeg');
const { FFMPEG_PATH, downloadDir } = require('../config');

// ─── Download one track (audio + optional cover) ───────────────────────────────
async function downloadTrack(entryUrl, songPath, coverPath, safeQ, needsCover, title) {
    const ts  = Date.now();
    const uid = Math.random().toString(36).slice(2, 6);

    // ── Audio (no embedded thumbnail) ─────────────────────────────────────────
    await ytDlp(entryUrl, {
        extractAudio:   true,
        audioFormat:    'mp3',
        audioQuality:   safeQ,
        output:         songPath,
        ffmpegLocation: FFMPEG_PATH,
        addMetadata:    true,
        embedThumbnail: false,    // OFF — cover saved separately + resized
        noPlaylist:     true,
        forceOverwrite: true,
        socketTimeout:  120,      // raised from 60 → 120 s
        // Strip non-essential metadata tags to keep MP3 size lean
        postprocessorArgs: 'ffmpeg:-map_metadata 0 -metadata comment= -metadata description= -metadata synopsis=',
    });

    if (!needsCover) return { hasCover: false };

    // ── Thumbnail: fetch raw, then resize to 500×500 ──────────────────────────
    const rawBase = path.join(downloadDir, `tmp-raw-${ts}-${uid}`);
    const rawDest = path.join(downloadDir, `tmp-raw-${ts}-${uid}.jpg`);
    let hasCover  = false;

    try {
        await ytDlp(entryUrl, {
            skipDownload:      true,
            writeThumbnail:    true,
            convertThumbnails: 'jpg',
            output:            rawBase,
            ffmpegLocation:    FFMPEG_PATH,
            noPlaylist:        true,
            socketTimeout:     60,
        });

        const baseFile = path.basename(rawBase);
        const found    = fs.readdirSync(downloadDir)
            .find(f => f.startsWith(baseFile) && /\.(jpg|jpeg|png|webp)$/i.test(f));

        if (found) {
            const src = path.join(downloadDir, found);
            if (src !== rawDest) fs.renameSync(src, rawDest);
            await resizeCover(rawDest, coverPath);
            hasCover = fs.existsSync(coverPath);
        }
    } catch (e) {
        console.log(`⚠️  Cover skipped for "${title}": ${e.message}`);
    } finally {
        tryUnlink(rawDest);
    }

    return { hasCover };
}

module.exports = { downloadTrack };
