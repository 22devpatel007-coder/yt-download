const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');

const { CONCURRENCY, downloadDir } = require('../config');
const sessions = require('../sessions/store');
const { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre } = require('../utils/fileHelper');
const { downloadTrack } = require('../downloader/trackDownloader');
const { fetchPlaylistCover } = require('../downloader/playlistCover');
const { setupArchive } = require('../downloader/archiveBuilder');
const { buildManifest } = require('../downloader/manifestBuilder');
const { runWorkerPool } = require('../downloader/workerPool');

// ─── Clean YouTube title → extract real song title + artist ───────────────────
function parseTitle(rawTitle, uploaderName) {
    let t = rawTitle
        .replace(/\s*\|.*$/i, '')
        .replace(/\s*\/\/.*$/i, '')
        .trim();

    t = t
        .replace(/\(?\s*(official\s*)?(lyrics?\s*)?(video|audio|music video|mv|hd|4k|visualizer|lyric video|audio video)\s*\)?/gi, '')
        .replace(/\(?\s*lyrics?\s*\)?/gi, '')
        .replace(/\(?\s*ft\.?[^)]*\)?\s*$/gi, '')
        .replace(/\[\s*[^\]]*\]/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (t.includes(' - ')) {
        const parts = t.split(/\s+-\s+/);
        const left = parts[0].trim();
        const right = parts.slice(1).join(' - ').trim();

        if (left && right) {
            const uploaderLower = uploaderName.toLowerCase();
            const leftLower = left.toLowerCase();
            const rightLower = right.toLowerCase();

            if (rightLower.includes(uploaderLower) || uploaderLower.includes(rightLower)) {
                return { title: left, artist: right };
            }
            if (leftLower.includes(uploaderLower) || uploaderLower.includes(leftLower)) {
                return { title: right, artist: left };
            }
            if (left.split(' ').length <= right.split(' ').length) {
                return { title: right, artist: left };
            } else {
                return { title: left, artist: right };
            }
        }
    }

    return { title: t || rawTitle, artist: uploaderName };
}

// ─── Fetch full yt-dlp metadata for a single entry ────────────────────────────
//  Flat playlist entries are stubs — no tags/genre/categories.
//  This fetches the real page metadata for one video URL.
async function fetchFullMeta(entryUrl) {
    try {
        return await ytDlp(entryUrl, {
            dumpSingleJson: true,
            noPlaylist: true,
            socketTimeout: 30,
        });
    } catch {
        return null;
    }
}

async function runDownload(url, safeQ, mode, res) {
    const send = d => {
        try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { }
    };

    const tempFiles = [];
    let zipPath = null;

    try {
        send({ status: 'fetching', message: 'Fetching playlist info…' });

        const info = await ytDlp(url, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 30 });
        const entries = info.entries || [info];
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

        send({ status: 'fetching', message: 'Looking up track metadata…' });

        // ── Build basic track meta from flat entries ───────────────────────────
        const trackMeta = entries.map((v, i) => {
            const index = String(i + 1).padStart(2, '0');
            const rawUploader = v.uploader || v.channel || 'Unknown Artist';
            const { title: parsedTitle, artist: parsedArtist } = parseTitle(v.title || `Track ${index}`, rawUploader);
            const title = safeName(v.track || parsedTitle);
            const artist = safeName(v.artist || v.creator || parsedArtist);
            const mp3Name = `${title} - ${artist}.mp3`;
            const stem = `${index} - ${title}`;
            const coverName = `${stem}.jpg`;
            const entryUrl = getEntryUrl(v, url);
            return { i, index, title, artist, mp3Name, coverName, entryUrl, flatEntry: v };
        });

        const downloadResults = new Array(entries.length).fill(null);
        let completedCount = 0;

        const processEntry = async (v, i) => {
            if (res.destroyed || res.writableEnded) return;

            const meta = trackMeta[i];
            if (!meta.entryUrl) {
                console.warn(`[SKIP] Entry ${i + 1}: no URL`);
                completedCount++;
                return;
            }

            const { index, title, artist, mp3Name, coverName } = meta;

            // ── Fetch full metadata for this track to get genre ────────────────
            //    This is the key fix: flat entries have no tags/genre/categories.
            //    We fetch the full video page for each track individually.
            const fullMeta = await fetchFullMeta(meta.entryUrl);
            const richEntry = fullMeta || meta.flatEntry;

            const duration = Math.round(richEntry.duration || meta.flatEntry.duration || 0);
            const genre = await fetchGenre(title, artist, richEntry);

            const ts = Date.now();
            const uid = Math.random().toString(36).slice(2, 6);
            const songPath = path.join(downloadDir, `tmp-${ts}-${uid}.mp3`);
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
                    total: entries.length,
                    title,
                    status: 'downloading',
                });
                return;
            }

            downloadResults[i] = {
                i,
                songPath: fs.existsSync(songPath) ? songPath : null,
                coverPath: fs.existsSync(coverPath) ? coverPath : null,
                hasCover,
                mp3Name, coverName, index, title, artist, genre, duration,
            };

            completedCount++;
            send({
                percent: ((completedCount / entries.length) * 100).toFixed(1),
                current: completedCount,
                total: entries.length,
                title,
                status: 'downloading',
            });
        };

        await runWorkerPool(entries, CONCURRENCY, res, processEntry);

        const manifest = [];
        const sessionEntries = [];

        for (const r of downloadResults) {
            if (!r) continue;

            if (r.songPath) {
                archive.file(r.songPath, {
                    name: mode === 'flat' ? r.mp3Name : `songs/${r.mp3Name}`,
                    store: true,
                });
            }

            if (needsCover && r.hasCover && r.coverPath) {
                archive.file(r.coverPath, { name: `covers/${r.coverName}`, store: true });
            }

            manifest.push({
                file: mode === 'flat' ? r.mp3Name : `songs/${r.mp3Name}`,
                cover: `covers/${r.coverName}`,
                title: r.title,
                artist: r.artist,
                genre: r.genre,
                duration: r.duration,
                tags: entries[r.i]?.tags || [],
            });

            sessionEntries.push({
                idx: r.i,
                trackNum: r.index,
                mp3Name: r.mp3Name,
                coverName: r.coverName,
                hasCover: needsCover ? r.hasCover : false,
                title: r.title,
                artist: r.artist,
                genre: r.genre,
                duration: r.duration,
                durationFmt: fmtDuration(r.duration),
            });
        }

        buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath);

        await finalizeArchive();

        tempFiles.forEach(tryUnlink);

        const existing = sessions.get(sessionId) || { albumName, entries: sessionEntries, createdAt: Date.now() };
        const sessionData = { ...existing, albumName, entries: sessionEntries, createdAt: Date.now() };
        if (mode === 'structured') sessionData.zipFile = path.basename(zipPath);
        if (mode === 'flat') sessionData.flatZipFile = path.basename(zipPath);
        if (mode === 'personal') sessionData.personalZipFile = path.basename(zipPath);
        sessions.set(sessionId, sessionData);

        send({
            done: true,
            percent: '100.0',
            sessionId,
            mode,
            fileName: path.basename(zipPath),
            albumName,
            trackCount: sessionEntries.length,
            tracks: sessionEntries,
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