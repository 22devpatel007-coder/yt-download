const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');

const { CONCURRENCY, downloadDir } = require('../config');
const sessions = require('../sessions/store');
const { safeName, tryUnlink, getEntryUrl, fmtDuration } = require('../utils/fileHelper');
const { downloadTrack } = require('../downloader/trackDownloader');
const { fetchPlaylistCover } = require('../downloader/playlistCover');
const { setupArchive } = require('../downloader/archiveBuilder');
const { buildManifest } = require('../downloader/manifestBuilder');
const { runWorkerPool } = require('../downloader/workerPool');

async function runDownload(url, safeQ, mode, res) {
    const send = d => {
        try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {}
    };

    const tempFiles = [];
    let zipPath = null;

    try {
        send({ status: 'fetching', message: 'Fetching playlist info…' });

        const info      = await ytDlp(url, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 30 });
        const entries   = info.entries || [info];
        const albumName = safeName(info.title || 'download');
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const suffixMap = { flat: '-flat', personal: '-personal', structured: '' };
        zipPath = path.join(downloadDir, `${albumName}${suffixMap[mode] || ''}-${sessionId}.zip`);

        const { archive, addToArchive, finalizeArchive } = setupArchive(zipPath, send, res);

        // ── Playlist-level cover (personal mode only) ──────────────────────────
        let playlistCoverPath = null;
        if (mode === 'personal') {
            playlistCoverPath = await fetchPlaylistCover(url, tempFiles);
        }

        const needsCover     = mode === 'structured' || mode === 'personal';
        const manifest       = [];
        const sessionEntries = new Array(entries.length).fill(null);
        let completedCount   = 0;

        // ── Per-entry worker ──────────────────────────────────────────────────
        const processEntry = async (v, i) => {
            if (res.destroyed || res.writableEnded) return;

            const entryUrl = getEntryUrl(v, url);
            if (!entryUrl) { console.warn(`[SKIP] Entry ${i + 1}: no URL`); return; }

            const index    = String(i + 1).padStart(2, '0');
            const title    = safeName(v.title || `Track ${index}`);
            const artist   = v.uploader || v.channel || 'Unknown Artist';
            const genre    = v.genre    || 'Unknown';
            const duration = Math.round(v.duration || 0);
            const stem     = `${index} - ${title}`;
            const mp3Name  = `${stem}.mp3`;
            const coverName = `${stem}.jpg`;

            const ts       = Date.now();
            const uid      = Math.random().toString(36).slice(2, 6);
            const songPath = path.join(downloadDir, `tmp-${ts}-${uid}.mp3`);
            const coverPath = path.join(downloadDir, `tmp-${ts}-${uid}-cover.jpg`);
            tempFiles.push(songPath, coverPath);

            console.log(`⬇️  [${i + 1}/${entries.length}] ${title} (${mode})`);

            let hasCover = false;
            try {
                const result = await downloadTrack(entryUrl, songPath, coverPath, safeQ, needsCover, title);
                hasCover = result.hasCover;
            } catch (err) {
                console.error(`[TRACK FAIL] ${title}:`, err.message);
                send({ warning: true, message: `Skipped: ${title} (download failed)` });
                return;
            }

            // Serialise archive writes
            await addToArchive(async () => {
                if (fs.existsSync(songPath)) {
                    archive.file(songPath, { name: mode === 'flat' ? mp3Name : `songs/${mp3Name}`, store: true });
                }
                if (needsCover && hasCover && fs.existsSync(coverPath)) {
                    archive.file(coverPath, { name: `covers/${coverName}`, store: true });
                }
            });

            if (mode !== 'flat') manifest.push({ file: mp3Name, title, artist, genre, duration });

            sessionEntries[i] = {
                idx: i, trackNum: index, mp3Name, coverName,
                hasCover: needsCover ? hasCover : false,
                title, artist, genre, duration,
                durationFmt: fmtDuration(duration),
            };

            completedCount++;
            send({
                percent: ((completedCount / entries.length) * 100).toFixed(1),
                current: completedCount,
                total:   entries.length,
                title,
                status: 'downloading',
            });
        };

        // ── Parallel pool: CONCURRENCY tracks at a time ───────────────────────
        await runWorkerPool(entries, CONCURRENCY, res, processEntry);

        // ── manifest.json ─────────────────────────────────────────────────────
        buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath);

        await finalizeArchive();

        tempFiles.forEach(tryUnlink);

        const validEntries = sessionEntries.filter(Boolean);
        const existing     = sessions.get(sessionId) || { albumName, entries: validEntries, createdAt: Date.now() };
        const sessionData  = { ...existing, albumName, entries: validEntries, createdAt: Date.now() };
        if (mode === 'structured') sessionData.zipFile         = path.basename(zipPath);
        if (mode === 'flat')       sessionData.flatZipFile     = path.basename(zipPath);
        if (mode === 'personal')   sessionData.personalZipFile = path.basename(zipPath);
        sessions.set(sessionId, sessionData);

        send({
            done:       true,
            percent:    '100.0',
            sessionId,
            mode,
            fileName:   path.basename(zipPath),
            albumName,
            trackCount: validEntries.length,
            tracks:     validEntries,
        });

        if (!res.writableEnded) res.end();
        setTimeout(() => tryUnlink(zipPath), 30 * 60_000);

    } catch (err) {
        console.error('[DOWNLOAD]', err.message);
        tempFiles.forEach(tryUnlink);
        if (zipPath) tryUnlink(zipPath);
        send({ error: true, message: 'Download failed. Please try again.' });
        if (!res.writableEnded) res.end();
    }
}

module.exports = { runDownload };
