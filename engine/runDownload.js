const ytDlp = require('yt-dlp-exec');
const path  = require('path');
const fs    = require('fs');

const { CONCURRENCY, downloadDir } = require('../config');
const sessions  = require('../sessions/store');
const { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre } = require('../utils/fileHelper');
const { downloadTrack }      = require('../downloader/trackDownloader');
const { fetchPlaylistCover } = require('../downloader/playlistCover');
const { setupArchive }       = require('../downloader/archiveBuilder');
const { buildManifest }      = require('../downloader/manifestBuilder');
const { runWorkerPool }      = require('../downloader/workerPool');

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

        const needsCover = mode === 'structured' || mode === 'personal';

        // ── Pre-fetch ALL genres in parallel BEFORE downloads start ────────────
        //
        //  The old code called fetchGenre() inside processEntry — meaning every
        //  track waited ~200ms for MusicBrainz before yt-dlp even started.
        //  With CONCURRENCY=3 and 12 tracks: that's 12 × 200ms = 2.4s of pure
        //  waiting scattered across the pool, blocking download slots.
        //
        //  Pre-fetching all genres together with Promise.all() costs ~200-500ms
        //  total (requests run in parallel) then every download slot starts
        //  immediately with no metadata waiting.
        //
        send({ status: 'fetching', message: 'Looking up track metadata…' });

        const trackMeta = await Promise.all(entries.map(async (v, i) => {
            const index  = String(i + 1).padStart(2, '0');
            const title  = safeName(v.title || `Track ${index}`);
            const artist = v.uploader || v.channel || 'Unknown Artist';

            const genre = v.genre && v.genre.trim() && v.genre.trim().toLowerCase() !== 'unknown'
                ? v.genre.trim()
                : await fetchGenre(title, artist);

            const duration  = Math.round(v.duration || 0);
            const mp3Name   = `${safeName(title)} - ${safeName(artist)}.mp3`;
            const stem      = `${index} - ${title}`;
            const coverName = `${stem}.jpg`;
            const entryUrl  = getEntryUrl(v, url);

            return { i, index, title, artist, genre, duration, mp3Name, coverName, entryUrl };
        }));

        // ── Results array — indexed by original track position ─────────────────
        //
        //  Promise.all + workerPool mean tracks finish out of order.
        //  Storing results at downloadResults[i] lets us archive them
        //  in the correct sequence after all downloads complete.
        //
        const downloadResults = new Array(entries.length).fill(null);
        let completedCount    = 0;

        // ── Per-entry worker ───────────────────────────────────────────────────
        const processEntry = async (v, i) => {
            if (res.destroyed || res.writableEnded) return;

            const meta = trackMeta[i];
            if (!meta.entryUrl) {
                console.warn(`[SKIP] Entry ${i + 1}: no URL`);
                completedCount++;
                return;
            }

            const { index, title, artist, genre, duration, mp3Name, coverName } = meta;

            const ts        = Date.now();
            const uid       = Math.random().toString(36).slice(2, 6);
            const songPath  = path.join(downloadDir, `tmp-${ts}-${uid}.mp3`);
            const coverPath = path.join(downloadDir, `tmp-${ts}-${uid}-cover.jpg`);
            tempFiles.push(songPath, coverPath);

            console.log(`⬇️  [${i + 1}/${entries.length}] ${title} — ${artist} [${genre}] (${mode})`);

            let hasCover = false;
            try {
                const result = await downloadTrack(
                    meta.entryUrl, songPath, coverPath, safeQ, needsCover,
                    title, artist, genre
                );
                hasCover = result.hasCover;
            } catch (err) {
                console.error(`[TRACK FAIL] ${title}:`, err.message);
                send({ warning: true, message: `Skipped: ${title} (download failed)` });
                completedCount++;
                send({
                    percent: ((completedCount / entries.length) * 100).toFixed(1),
                    current: completedCount,
                    total:   entries.length,
                    title,
                    status:  'downloading',
                });
                return;
            }

            // Store at original index so archive order is always correct
            downloadResults[i] = {
                i,
                songPath:  fs.existsSync(songPath)  ? songPath  : null,
                coverPath: fs.existsSync(coverPath) ? coverPath : null,
                hasCover,
                mp3Name, coverName, index, title, artist, genre, duration,
            };

            completedCount++;
            send({
                percent: ((completedCount / entries.length) * 100).toFixed(1),
                current: completedCount,
                total:   entries.length,
                title,
                status:  'downloading',
            });
        };

        // ── Parallel pool — CONCURRENCY slots running at once ──────────────────
        await runWorkerPool(entries, CONCURRENCY, res, processEntry);

        // ── Archive in original order AFTER all downloads finish ───────────────
        //
        //  The old code called addToArchive() (a mutex) inside processEntry,
        //  meaning a fast track finishing early would still wait behind a slow
        //  one just to write its file. Archiving pre-downloaded files takes
        //  milliseconds — doing it sequentially after all downloads is faster
        //  overall and removes the lock entirely.
        //
        const manifest       = [];
        const sessionEntries = [];

        for (const r of downloadResults) {
            if (!r) continue;

            if (r.songPath) {
                archive.file(r.songPath, {
                    name:  mode === 'flat' ? r.mp3Name : `songs/${r.mp3Name}`,
                    store: true,
                });
            }

            if (needsCover && r.hasCover && r.coverPath) {
                archive.file(r.coverPath, { name: `covers/${r.coverName}`, store: true });
            }

            if (mode !== 'flat') {
                manifest.push({
                    file:     r.mp3Name,
                    title:    r.title,
                    artist:   r.artist,
                    genre:    r.genre,
                    duration: r.duration,
                });
            }

            sessionEntries.push({
                idx:         r.i,
                trackNum:    r.index,
                mp3Name:     r.mp3Name,
                coverName:   r.coverName,
                hasCover:    needsCover ? r.hasCover : false,
                title:       r.title,
                artist:      r.artist,
                genre:       r.genre,
                duration:    r.duration,
                durationFmt: fmtDuration(r.duration),
            });
        }

        // ── manifest.json ──────────────────────────────────────────────────────
        buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath);

        await finalizeArchive();

        tempFiles.forEach(tryUnlink);

        const existing    = sessions.get(sessionId) || { albumName, entries: sessionEntries, createdAt: Date.now() };
        const sessionData = { ...existing, albumName, entries: sessionEntries, createdAt: Date.now() };
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
            trackCount: sessionEntries.length,
            tracks:     sessionEntries,
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