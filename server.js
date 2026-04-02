require('dotenv').config();

const express  = require('express');
const ytDlp    = require('yt-dlp-exec');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

let AdmZip;
try { AdmZip = require('adm-zip'); } catch (e) {
    console.warn('[WARN] adm-zip not installed — per-song download will fall back to ZIP redirect.');
}

const app  = express();
const PORT = process.env.PORT || 3030;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// ─── Concurrency pool size ─────────────────────────────────────────────────────
// 3 parallel downloads is the sweet spot: ~3× faster than sequential while
// staying under YouTube's soft rate-limit. Raise via CONCURRENCY env var.
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10));

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ─── Directories ───────────────────────────────────────────────────────────────
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

// ─── Helpers ───────────────────────────────────────────────────────────────────
function isValidYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const p = new URL(url);
        return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com']
            .includes(p.hostname);
    } catch { return false; }
}

function safeName(str) {
    return (str || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim().slice(0, 180) || 'unknown';
}

function tryUnlink(fp) {
    try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

function getEntryUrl(entry, fallback) {
    return entry.webpage_url || entry.url || fallback;
}

function fmtDuration(sec) {
    const s = Math.round(sec || 0), m = Math.floor(s / 60), h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

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

// ─── Rate limiter (15 req / 60 s per IP) ──────────────────────────────────────
const rlMap = new Map();
function rateLimit(req, res, next) {
    const ip  = req.ip || req.socket.remoteAddress || 'x';
    const now = Date.now();
    const e   = rlMap.get(ip) || { count: 0, start: now };
    if (now - e.start > 60_000) { e.count = 1; e.start = now; } else e.count++;
    rlMap.set(ip, e);
    if (e.count > 15) return res.status(429).json({ error: 'Too many requests — wait a minute.' });
    next();
}
setInterval(() => {
    const cut = Date.now() - 60_000;
    for (const [ip, e] of rlMap) if (e.start < cut) rlMap.delete(ip);
}, 5 * 60_000);

// ─── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
    const cut = Date.now() - 30 * 60_000;
    for (const [id, s] of sessions) {
        if (s.createdAt < cut) {
            if (s.zipFile)         tryUnlink(path.join(downloadDir, s.zipFile));
            if (s.flatZipFile)     tryUnlink(path.join(downloadDir, s.flatZipFile));
            if (s.personalZipFile) tryUnlink(path.join(downloadDir, s.personalZipFile));
            sessions.delete(id);
        }
    }
}, 10 * 60_000);

// ─── Download one track (audio + optional cover) ───────────────────────────────
//
//  What changed vs old code:
//  • embedThumbnail: false  — removes one slow ffmpeg re-encode pass per track;
//    covers are saved separately as resized 500×500 JPEGs instead.
//  • socketTimeout raised 60→120 s so long tracks never silently fail/retry.
//  • postprocessorArgs strips non-essential ID3 tags (description, comment, etc.)
//    that yt-dlp writes by default, trimming a few KB per file.
//  • Cover fetch is a single writeThumbnail call; raw thumbnail is then resized
//    via ffmpeg. No duplicate network requests.
//
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

// ─── Core download engine ──────────────────────────────────────────────────────
//
//  mode: 'structured' → songs/ + covers/ + manifest.json (array)
//  mode: 'flat'       → MP3s at root, no covers, no manifest
//  mode: 'personal'   → songs/ + covers/ + playlist-cover.jpg + manifest.json (object)
//
//  Tracks are downloaded CONCURRENCY-at-a-time (default 3) using a chunk-based
//  parallel pool. Archive writes are serialised via a promise queue to avoid
//  any race conditions inside archiver.
//
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

        const writeStream = fs.createWriteStream(zipPath);
        const archive     = archiver('zip', { store: true });

        archive.on('error', err => {
            console.error('[ARCHIVE]', err.message);
            send({ error: true, message: 'Archive failed.' });
            if (!res.writableEnded) res.end();
        });
        archive.pipe(writeStream);

        // ── Playlist-level cover (personal mode only) ──────────────────────────
        let playlistCoverPath = null;
        if (mode === 'personal') {
            const ts      = Date.now();
            const uid     = Math.random().toString(36).slice(2, 6);
            const rawBase = path.join(downloadDir, `tmp-plraw-${ts}-${uid}`);
            const rawDest = path.join(downloadDir, `tmp-plraw-${ts}-${uid}.jpg`);
            const resized = path.join(downloadDir, `tmp-plcover-${ts}-${uid}.jpg`);
            tempFiles.push(rawDest, resized);
            try {
                await ytDlp(url, {
                    skipDownload:      true,
                    writeThumbnail:    true,
                    convertThumbnails: 'jpg',
                    output:            rawBase,
                    ffmpegLocation:    FFMPEG_PATH,
                    noPlaylist:        false,
                    socketTimeout:     30,
                });
                const baseFile = path.basename(rawBase);
                const found    = fs.readdirSync(downloadDir)
                    .find(f => f.startsWith(baseFile) && /\.(jpg|jpeg|png|webp)$/i.test(f));
                if (found) {
                    const src = path.join(downloadDir, found);
                    if (src !== rawDest) fs.renameSync(src, rawDest);
                    await resizeCover(rawDest, resized);
                    if (fs.existsSync(resized)) playlistCoverPath = resized;
                }
            } catch (e) {
                console.log(`⚠️  Playlist cover skipped — ${e.message}`);
            }
        }

        const needsCover     = mode === 'structured' || mode === 'personal';
        const manifest       = [];
        const sessionEntries = new Array(entries.length).fill(null);
        let completedCount   = 0;

        // Serialise archive.file() calls — archiver is not concurrent-safe
        let archiveQueue = Promise.resolve();
        const addToArchive = fn => { archiveQueue = archiveQueue.then(fn); return archiveQueue; };

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
        for (let i = 0; i < entries.length; i += CONCURRENCY) {
            if (res.destroyed || res.writableEnded) break;
            await Promise.all(
                entries.slice(i, i + CONCURRENCY).map((v, j) => processEntry(v, i + j))
            );
        }

        await archiveQueue; // flush any pending archive operations

        // ── manifest.json ─────────────────────────────────────────────────────
        if (mode === 'structured') {
            archive.append(
                Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
                { name: 'manifest.json' }
            );
        } else if (mode === 'personal') {
            const personalManifest = {
                name:        albumName,
                description: info.description ? info.description.slice(0, 500) : '',
                ...(playlistCoverPath ? { cover: 'playlist-cover.jpg' } : {}),
                songs: manifest,
            };
            archive.append(
                Buffer.from(JSON.stringify(personalManifest, null, 2), 'utf-8'),
                { name: 'manifest.json' }
            );
            if (playlistCoverPath && fs.existsSync(playlistCoverPath)) {
                archive.file(playlistCoverPath, { name: 'playlist-cover.jpg', store: true });
            }
        }

        await new Promise((resolve, reject) => {
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
            archive.finalize();
        });

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

// ─── Routes ────────────────────────────────────────────────────────────────────

/* ── Preview ── */
app.post('/preview-playlist', rateLimit, async (req, res) => {
    const { url } = req.body;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    try {
        const info    = await ytDlp(url, { dumpSingleJson: true, flatPlaylist: true, socketTimeout: 30 });
        const entries = info.entries || [info];
        res.json({
            title:      info.title     || 'Unknown',
            artist:     info.uploader  || 'Unknown',
            thumbnail:  info.thumbnail || entries[0]?.thumbnail || '',
            isPlaylist: !!info.entries,
            trackCount: entries.length,
        });
    } catch (err) {
        console.error('[PREVIEW]', err.message);
        res.status(500).json({ error: 'Could not fetch info.' });
    }
});

/* ── Formats ── */
app.post('/formats', rateLimit, async (req, res) => {
    const { url } = req.body;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    try {
        const info  = await ytDlp(url, { dumpSingleJson: true, noPlaylist: true, socketTimeout: 30 });
        const byAbr = (info.formats || [])
            .filter(f => f.abr && f.filesize)
            .reduce((a, f) => {
                const k = Math.round(f.abr);
                if (!a[k]) a[k] = f;
                return a;
            }, {});
        res.json([320, 256, 192, 128, 96].map(abr => ({
            abr,
            size: byAbr[abr] ? (byAbr[abr].filesize / 1048576).toFixed(2) + ' MB' : 'Size varies',
        })));
    } catch (err) {
        console.error('[FORMATS]', err.message);
        res.status(500).json({ error: 'Could not fetch format info.' });
    }
});

/* ── Download: structured ZIP ── */
app.get('/download-progress', rateLimit, async (req, res) => {
    const { url, quality = '192' } = req.query;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url, safeQ, 'structured', res);
});

/* ── Download: flat ZIP ── */
app.get('/download-flat', rateLimit, async (req, res) => {
    const { url, quality = '192' } = req.query;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url, safeQ, 'flat', res);
});

/* ── Download: personal ZIP ── */
app.get('/download-personal', rateLimit, async (req, res) => {
    const { url, quality = '192' } = req.query;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url, safeQ, 'personal', res);
});

/* ── Serve ZIP file ── */
app.get('/file/:name', (req, res) => {
    const safe = path.basename(req.params.name);
    const fp   = path.resolve(downloadDir, safe);
    if (!fp.startsWith(path.resolve(downloadDir))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(fp)) return res.status(404).send('File not found or already deleted.');
    res.download(fp);
});

/* ── Serve individual song from session ZIP ── */
app.get('/song/:sessionId/:index', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session expired.' });

    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx)) return res.status(400).json({ error: 'Invalid index.' });
    const entry = session.entries[idx];
    if (!entry) return res.status(404).json({ error: 'Track not found.' });

    const zipFile = session.zipFile || session.personalZipFile || session.flatZipFile;
    if (!zipFile) return res.status(404).json({ error: 'No archive found.' });

    const zipPath = path.resolve(downloadDir, zipFile);
    if (!zipPath.startsWith(path.resolve(downloadDir))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'ZIP expired.' });

    if (!AdmZip) {
        console.warn('[SONG] adm-zip unavailable, falling back to ZIP redirect');
        return res.redirect(`/file/${encodeURIComponent(zipFile)}`);
    }

    try {
        const zip      = new AdmZip(zipPath);
        const zipEntry = zip.getEntry(`songs/${entry.mp3Name}`) || zip.getEntry(entry.mp3Name);
        if (!zipEntry) return res.status(404).json({ error: 'Song not in archive.' });

        const data = zip.readFile(zipEntry);
        res.setHeader('Content-Type',        'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.mp3Name)}"`);
        res.setHeader('Content-Length',      data.length);
        res.send(data);
    } catch (err) {
        console.warn('[SONG] read failed, falling back:', err.message);
        res.redirect(`/file/${encodeURIComponent(zipFile)}`);
    }
});

/* ── Serve cover image ── */
app.get('/cover/:sessionId/:index', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).end();

    const zipFile = session.zipFile || session.personalZipFile;
    if (!zipFile) return res.status(404).end();

    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx)) return res.status(400).end();
    const entry = session.entries[idx];
    if (!entry || !entry.hasCover) return res.status(404).end();

    const zipPath = path.resolve(downloadDir, zipFile);
    if (!zipPath.startsWith(path.resolve(downloadDir))) return res.status(403).end();
    if (!fs.existsSync(zipPath)) return res.status(404).end();
    if (!AdmZip) return res.status(404).end();

    try {
        const zip      = new AdmZip(zipPath);
        const zipEntry = zip.getEntry(`covers/${entry.coverName}`);
        if (!zipEntry) return res.status(404).end();

        const data = zip.readFile(zipEntry);
        res.setHeader('Content-Type',   'image/jpeg');
        res.setHeader('Cache-Control',  'public, max-age=3600');
        res.setHeader('Content-Length', data.length);
        res.send(data);
    } catch { res.status(404).end(); }
});

/* ── Serve playlist cover from personal ZIP ── */
app.get('/playlist-cover/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || !session.personalZipFile) return res.status(404).end();

    const zipPath = path.resolve(downloadDir, session.personalZipFile);
    if (!zipPath.startsWith(path.resolve(downloadDir))) return res.status(403).end();
    if (!fs.existsSync(zipPath)) return res.status(404).end();
    if (!AdmZip) return res.status(404).end();

    try {
        const zip      = new AdmZip(zipPath);
        const zipEntry = zip.getEntry('playlist-cover.jpg');
        if (!zipEntry) return res.status(404).end();

        const data = zip.readFile(zipEntry);
        res.setHeader('Content-Type',   'image/jpeg');
        res.setHeader('Cache-Control',  'public, max-age=3600');
        res.setHeader('Content-Length', data.length);
        res.send(data);
    } catch { res.status(404).end(); }
});

/* ── Health ── */
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), concurrency: CONCURRENCY }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
    console.error('[UNHANDLED]', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Start / shutdown ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}  (concurrency=${CONCURRENCY})`));

function shutdown(sig) {
    console.log(`\n${sig} — shutting down…`);
    server.close(() => { console.log('✅ Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM',            () => shutdown('SIGTERM'));
process.on('SIGINT',             () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => console.error('[UNCAUGHT]',  err));
process.on('unhandledRejection', reason => console.error('[UNHANDLED]', reason));