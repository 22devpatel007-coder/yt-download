const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');

const { CONCURRENCY, downloadDir } = require('../config');
const sessions = require('../sessions/store');
const { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre, extractGenre } = require('../utils/fileHelper');
const { downloadTrack } = require('../downloader/trackDownloader');
const { fetchPlaylistCover } = require('../downloader/playlistCover');
const { setupArchive } = require('../downloader/archiveBuilder');
const { buildManifest } = require('../downloader/manifestBuilder');
const { runWorkerPool } = require('../downloader/workerPool');
const { lookupArtist } = require('../utils/musicbrainz');
// ─── Clean YouTube title → extract real song title + artist ───────────────────
function parseTitle(rawTitle, uploaderName) {
    let t = rawTitle
        .replace(/\s*\|.*$/i, '')
        .replace(/\s*\/\/.*$/i, '')
        .trim();

    t = t
        .replace(/\(?\s*(official\s*)?(lyrics?\s*)?(video|audio|music video|mv|hd|4k|visualizer|lyric video|audio video|lyrical)\s*\)?/gi, '')
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
            return { title: right, artist: left };
        }
    }

    return { title: t || rawTitle, artist: uploaderName };
}

// ─── Fetch full yt-dlp metadata for a single entry ────────────────────────────
//  Flat playlist entries are stubs — no tags/genre/categories.
//  This fetches the real page metadata for one video URL.
async function fetchFullMeta(entryUrl) {
    try {
        const isSearch = entryUrl.startsWith('ytsearch');
        const opts = { dumpSingleJson: true, socketTimeout: 30 };
        if (!isSearch) opts.noPlaylist = true;
        const result = await ytDlp(entryUrl, opts);
       // console.log(`[fetchFullMeta] url=${entryUrl} duration=${result?.duration} entries0_dur=${result?.entries?.[0]?.duration}`);
        // For search queries, yt-dlp returns a playlist wrapper with entries
        // We need the actual video URL to get full metadata including duration
        if (isSearch) {
            const entry = result?.entries?.[0] || result;
            if (entry?.webpage_url || entry?.url) {
                const videoUrl = entry.webpage_url || entry.url;
                const full = await ytDlp(videoUrl, {
                    dumpSingleJson: true,
                    noPlaylist: true,
                    socketTimeout: 30,
                });
                const merged = full || entry;
                if (!merged.duration && entry.duration) merged.duration = entry.duration;
                return merged;
            }
            return entry;
        }

        return result;
    } catch (e) {
        // console.error('[fetchFullMeta ERROR]', e.message);
        return null;
    }
}

async function runDownload(url, safeQ, mode, res, spotifyToken = null) {
    const send = d => {
        try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { }
    };

    const tempFiles = [];
    let zipPath = null;

    try {
        send({ status: 'fetching', message: 'Fetching playlist info…' });

        let entries, albumName, info;

        if (spotifyToken) {
            const { spotifyTokenStore } = require('../routes/download');
            const stored = spotifyTokenStore.get(spotifyToken);
            if (!stored) throw new Error('Spotify session expired. Please try again.');
            albumName = safeName(stored.playlistName || 'Spotify Playlist');
            info = { description: '' };
            entries = stored.tracks.map(t => ({
                _spotifyTitle: t.title,
                _spotifyArtist: t.artist,
            }));
        } else {
            info = await ytDlp(url, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 30 });
            entries = info.entries || [info];
            albumName = safeName(info.title || 'download');
        }
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const suffixMap = { flat: '-flat', personal: '-personal', structured: '' };
        zipPath = path.join(downloadDir, `${albumName}${suffixMap[mode] || ''}-${sessionId}.zip`);

        const { archive, addToArchive, finalizeArchive } = setupArchive(zipPath, send, res);

        // ── Playlist-level cover (personal mode only) ──────────────────────────
        let playlistCoverPath = null;
        if (mode === 'personal' && url) {
            playlistCoverPath = await fetchPlaylistCover(url, tempFiles);
        }

        const needsCover = mode === 'structured' || mode === 'personal';

        send({ status: 'fetching', message: 'Looking up track metadata…' });

        // ── Build basic track meta from flat entries ───────────────────────────
        const trackMeta = entries.map((v, i) => {
            const index = String(i + 1).padStart(2, '0');
            let title, artist, entryUrl;
            if (v._spotifyTitle) {
                title = safeName(v._spotifyTitle);
                artist = safeName(v._spotifyArtist);
                entryUrl = `ytsearch1:${title} ${artist} official audio`;
            } else {
                const rawUploader = v.uploader || v.channel || 'Unknown Artist';
                const { title: parsedTitle, artist: parsedArtist } = parseTitle(v.title || `Track ${index}`, rawUploader);
                title = safeName(v.track || parsedTitle);
                artist = safeName(v.artist || v.creator || parsedArtist);
                entryUrl = v.webpage_url || v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : null);
            }
            const mp3Name = `${title} - ${artist}.mp3`;
            const coverName = `${index} - ${title}.jpg`;
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

            const { index } = meta;

            // ── Fetch full metadata for this track to get genre ────────────────
            const fullMeta = await fetchFullMeta(meta.entryUrl);

            // For ytsearch entries, yt-dlp returns a playlist wrapper — duration is inside entries[0]
            // console.log(`[DURATION DEBUG] entry ${i + 1}`, {
            //     fullMeta_duration: fullMeta?.duration,
            //     entries0_duration: fullMeta?.entries?.[0]?.duration,
            //     flatEntry_duration: meta.flatEntry?.duration,
            // });
            const duration = Math.round(
                fullMeta?.duration ||
                fullMeta?.entries?.[0]?.duration ||
                meta.flatEntry?.duration ||
                0
            );
            const genre = extractGenre(fullMeta || {});

            // ── If Spotify gave us title+artist, trust it completely ───────────
            let title, artist;
            if (meta.flatEntry?._spotifyTitle) {
                title = meta.title;
                artist = meta.artist;
            } else {
                const rawFullTitle = fullMeta?.title || meta.flatEntry.title || `Track ${index}`;
                const rawUploader = fullMeta?.uploader || fullMeta?.channel || 'Unknown Artist';
                const rawArtist = fullMeta?.artist || fullMeta?.creator || null;
                const { title: parsedTitle, artist: parsedArtistFull } = parseTitle(rawFullTitle, rawUploader);
                const rawTitle = fullMeta?.track || parsedTitle;
                title = safeName(rawTitle.replace(/full song|lyrical|official|lyrics/gi, '').replace(/\s*-\s*$/, '').trim());
                const firstArtist = rawArtist
                    ? rawArtist.split(',')[0].trim()
                    : parsedArtistFull && parsedArtistFull.toLowerCase() !== (fullMeta?.uploader || '').toLowerCase()
                        ? parsedArtistFull
                        : null;
                const mbArtist = await Promise.race([
                    lookupArtist(title),
                    new Promise(r => setTimeout(() => r(null), 5000))
                ]);
                artist = safeName(mbArtist || firstArtist || meta.artist);
            }

            const mp3Name = `${title} - ${artist}.mp3`;
            const coverName = `${index} - ${artist} - ${title}.jpg`;

            const ts = Date.now();
            const uid = Math.random().toString(36).slice(2, 6);
            const songPath = path.join(downloadDir, `tmp-${ts}-${uid}.mp3`);
            const coverPath = path.join(downloadDir, `tmp-${ts}-${uid}-cover.jpg`);
            tempFiles.push(songPath, coverPath);

            console.log(`⬇️  [${i + 1}/${entries.length}] ${title} — ${artist} [${genre}] (${mode})`);

            const downloadUrl = fullMeta?.webpage_url || fullMeta?.url || meta.entryUrl;
            let hasCover = false;
            try {
                const result = await downloadTrack(
                    downloadUrl, songPath, coverPath, safeQ, needsCover,
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
        console.error('[DOWNLOAD]', JSON.stringify(err));
        tempFiles.forEach(tryUnlink);
        if (zipPath) tryUnlink(zipPath);
        send({ error: true, message: 'Download failed. Please try again.' });
        if (!res.writableEnded) res.end();
    }
}

module.exports = { runDownload };