const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const { resizeCover } = require('../utils/ffmpeg');
const { FFMPEG_PATH, downloadDir } = require('../config');

async function fetchPlaylistCover(url, tempFiles) {
    let playlistCoverPath = null;
    const ts      = Date.now();
    const uid     = Math.random().toString(36).slice(2, 6);
    const rawBase = path.join(downloadDir, `tmp-plraw-${ts}-${uid}`);
    const rawDest = path.join(downloadDir, `tmp-plraw-${ts}-${uid}.jpg`);
    const resized = path.join(downloadDir, `tmp-plcover-${ts}-${uid}.jpg`);
    tempFiles.push(rawDest, resized);

    try {
        // Snapshot directory BEFORE download so we can detect the new file
        const before = new Set(fs.readdirSync(downloadDir));

        await ytDlp(url, {
            skipDownload:      true,
            writeThumbnail:    true,
            convertThumbnails: 'jpg',
            output:            rawBase,
            ffmpegLocation:    FFMPEG_PATH,
            socketTimeout:     30,
        });

        const found = fs.readdirSync(downloadDir)
            .find(f => !before.has(f) && /\.(jpg|jpeg|png|webp)$/i.test(f));

        if (found) {
            const src = path.join(downloadDir, found);
            if (src !== rawDest) fs.renameSync(src, rawDest);
            await resizeCover(rawDest, resized);
            if (fs.existsSync(resized)) playlistCoverPath = resized;
        }
    } catch (e) {
        console.log(`⚠️  Playlist cover skipped — ${e.message}`);
    }

    return playlistCoverPath;
}

module.exports = { fetchPlaylistCover };