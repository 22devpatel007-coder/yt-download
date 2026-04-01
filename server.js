require('dotenv').config();

const express  = require('express');
const ytDlp    = require('yt-dlp-exec');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');

const app  = express();
const PORT = process.env.PORT || 3030;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

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
        return ['youtube.com','www.youtube.com','youtu.be','m.youtube.com','music.youtube.com']
            .includes(p.hostname);
    } catch { return false; }
}

function safeName(str) {
    return (str || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]+/g,'').trim().slice(0,180) || 'unknown';
}

function tryUnlink(fp) {
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

function getEntryUrl(entry, fallback) {
    return entry.webpage_url || entry.url || fallback;
}

function fmtDuration(sec) {
    const s = Math.round(sec || 0), m = Math.floor(s/60), h = Math.floor(m/60);
    if (h > 0) return `${h}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    return `${m}:${String(s%60).padStart(2,'0')}`;
}

// ─── Rate limiter (15 req / 60 s per IP) ─────────────────────────────────────
const rlMap = new Map();
function rateLimit(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'x';
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

// ─── Session store (tracks completed downloads for per-song endpoint) ─────────
// sessionId → { albumName, zipFile, entries[], createdAt }
const sessions = new Map();
setInterval(() => {
    const cut = Date.now() - 30 * 60_000;
    for (const [id, s] of sessions) if (s.createdAt < cut) sessions.delete(id);
}, 10 * 60_000);

// ─── Routes ────────────────────────────────────────────────────────────────────

/* ── Preview (single + playlist) ─────────────────────────────────────────── */
app.post('/preview-playlist', rateLimit, async (req, res) => {
    const { url } = req.body;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    try {
        const info    = await ytDlp(url, { dumpSingleJson:true, flatPlaylist:true, socketTimeout:30 });
        const entries = info.entries || [info];
        res.json({
            title:      info.title    || 'Unknown',
            artist:     info.uploader || 'Unknown',
            thumbnail:  info.thumbnail || entries[0]?.thumbnail || '',
            isPlaylist: !!info.entries,
            trackCount: entries.length
        });
    } catch (err) {
        console.error('[PREVIEW]', err.message);
        res.status(500).json({ error: 'Could not fetch info.' });
    }
});

/* ── Formats ──────────────────────────────────────────────────────────────── */
app.post('/formats', rateLimit, async (req, res) => {
    const { url } = req.body;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    try {
        const info  = await ytDlp(url, { dumpSingleJson:true, noPlaylist:true, socketTimeout:30 });
        const byAbr = (info.formats||[])
            .filter(f => f.abr && f.filesize)
            .reduce((a,f) => { const k=Math.round(f.abr); if(!a[k]) a[k]=f; return a; }, {});
        res.json([320,256,192,128,96].map(abr => ({
            abr,
            size: byAbr[abr] ? (byAbr[abr].filesize/1048576).toFixed(2)+' MB' : 'Size varies'
        })));
    } catch (err) {
        console.error('[FORMATS]', err.message);
        res.status(500).json({ error: 'Could not fetch format info.' });
    }
});

/* ── Download with SSE progress ───────────────────────────────────────────────
   ZIP structure:
     your-songs.zip
     ├── songs/
     │   ├── 01 - Song Title.mp3
     │   └── 02 - Another Song.mp3
     ├── covers/              (optional, only if thumbnail found)
     │   └── 01 - Song Title.jpg
     └── manifest.json        (flat array per spec)
─────────────────────────────────────────────────────────────────────────────── */
app.get('/download-progress', rateLimit, async (req, res) => {
    const { url, quality = '192' } = req.query;
    if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });

    const safeQ = ['96','128','192','256','320'].includes(quality) ? quality : '192';

    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = d => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };

    const tempFiles = [];
    let zipPath = null;

    try {
        send({ status:'fetching', message:'Fetching info…' });

        const info    = await ytDlp(url, { dumpSingleJson:true, flatPlaylist:true, socketTimeout:30 });
        const entries = info.entries || [info];
        const albumName = safeName(info.title || 'download');
        const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

        zipPath = path.join(downloadDir, `${albumName}-${sessionId}.zip`);

        const writeStream = fs.createWriteStream(zipPath);
        const archive     = archiver('zip', { zlib:{ level:6 } });
        archive.on('error', err => { console.error('[ARCHIVE]', err.message); send({ error:true, message:'Archive failed.' }); res.end(); });
        archive.pipe(writeStream);

        // ── Spec-exact manifest (flat array) ──
        const manifest       = [];   // what goes into manifest.json
        const sessionEntries = [];   // what goes into the session for per-song download

        for (let i = 0; i < entries.length; i++) {
            if (res.destroyed || res.writableEnded) break;

            const v        = entries[i];
            const entryUrl = getEntryUrl(v, url);
            if (!entryUrl) { console.warn(`[SKIP] Entry ${i+1}: no URL`); continue; }

            const index    = String(i+1).padStart(2,'0');
            const title    = safeName(v.title || `Track ${index}`);
            const artist   = v.uploader || v.channel || 'Unknown Artist';
            const genre    = v.genre    || 'Unknown';
            const duration = Math.round(v.duration || 0);

            // ── Filenames match spec exactly ──
            const stem      = `${index} - ${title}`;   // e.g. "01 - Song Title"
            const mp3Name   = `${stem}.mp3`;            // songs/ subfolder
            const coverName = `${stem}.jpg`;            // covers/ subfolder (always jpg)

            const ts        = Date.now();
            const songPath  = path.join(downloadDir, `tmp-${ts}-${mp3Name}`);
            const coverPath = path.join(downloadDir, `tmp-${ts}-${coverName}`);
            const coverBase = path.join(downloadDir, `tmp-${ts}-${stem}`);

            tempFiles.push(songPath, coverPath);

            send({
                percent: ((i / entries.length) * 100).toFixed(1),
                current: i+1, total: entries.length,
                title, status: 'downloading'
            });

            console.log(`⬇️  [${i+1}/${entries.length}] ${title}`);

            /* ── Audio ── */
            try {
                await ytDlp(entryUrl, {
                    extractAudio:   true,
                    audioFormat:    'mp3',
                    audioQuality:   safeQ,
                    output:         songPath,
                    ffmpegLocation: FFMPEG_PATH,
                    addMetadata:    true,
                    embedThumbnail: true,
                    noPlaylist:     true,
                    forceOverwrite: true,
                    socketTimeout:  60
                });
            } catch (err) {
                console.error(`[AUDIO FAIL] ${title}:`, err.message);
                send({ warning:true, message:`Skipped: ${title} (download failed)` });
                continue;
            }

            /* ── Cover (optional) ── */
            let hasCover = false;
            try {
                await ytDlp(entryUrl, {
                    skipDownload:      true,
                    writeThumbnail:    true,
                    convertThumbnails: 'jpg',
                    output:            coverBase,
                    ffmpegLocation:    FFMPEG_PATH,
                    noPlaylist:        true,
                    socketTimeout:     30
                });
                const found = fs.readdirSync(downloadDir)
                    .find(f => f.startsWith(path.basename(coverBase)) && f.endsWith('.jpg'));
                if (found) {
                    fs.renameSync(path.join(downloadDir, found), coverPath);
                    hasCover = true;
                }
            } catch { console.log(`⚠️  Cover skipped: ${title}`); }

            /* ── ZIP entries ──
               songs/01 - Song Title.mp3
               covers/01 - Song Title.jpg  (only if cover found)
            ── */
            if (fs.existsSync(songPath))               archive.file(songPath,  { name:`songs/${mp3Name}` });
            if (hasCover && fs.existsSync(coverPath))  archive.file(coverPath, { name:`covers/${coverName}` });

            /* ── manifest.json entry (spec-exact flat array item) ── */
            manifest.push({
                file:     mp3Name,
                title,
                artist,
                genre,
                duration              // seconds
            });

            sessionEntries.push({
                idx: i,
                stem, mp3Name, coverName, hasCover,
                title, artist, genre,
                duration, durationFmt: fmtDuration(duration)
            });
        }

        /* ── manifest.json — flat array, root of zip ── */
        archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
                       { name: 'manifest.json' });

        /* ── Finalize zip ── */
        await new Promise((resolve, reject) => {
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
            archive.finalize();
        });

        tempFiles.forEach(tryUnlink);

        // Store session so /song endpoint can serve individual tracks
        sessions.set(sessionId, {
            albumName,
            zipFile:   path.basename(zipPath),
            entries:   sessionEntries,
            createdAt: Date.now()
        });

        send({
            done:       true,
            percent:    '100.0',
            sessionId,
            fileName:   path.basename(zipPath),
            albumName,
            trackCount: manifest.length,
            tracks:     sessionEntries    // UI uses this to build the track list
        });

        res.end();

        // Auto-delete zip after 30 min
        setTimeout(() => tryUnlink(zipPath), 30 * 60_000);

    } catch (err) {
        console.error('[DOWNLOAD-PROGRESS]', err.message);
        tempFiles.forEach(tryUnlink);
        if (zipPath) tryUnlink(zipPath);
        send({ error:true, message:'Download failed. Please try again.' });
        res.end();
    }
});

/* ── Download ZIP ─────────────────────────────────────────────────────────── */
app.get('/file/:name', (req, res) => {
    const safe = path.basename(req.params.name);
    const fp   = path.resolve(downloadDir, safe);
    if (!fp.startsWith(path.resolve(downloadDir))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(fp)) return res.status(404).send('File not found or already deleted.');
    res.download(fp);
});

/* ── Download single song from ZIP ───────────────────────────────────────────
   GET /song/:sessionId/:trackIndex
   Extracts and streams the individual .mp3 from the zip.
─────────────────────────────────────────────────────────────────────────────── */
app.get('/song/:sessionId/:index', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session expired.' });

    const idx   = parseInt(req.params.index, 10);
    const entry = session.entries[idx];
    if (!entry)  return res.status(404).json({ error: 'Track not found.' });

    const zipPath = path.resolve(downloadDir, session.zipFile);
    if (!zipPath.startsWith(path.resolve(downloadDir))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'ZIP expired.' });

    try {
        // adm-zip: npm install adm-zip
        const AdmZip  = require('adm-zip');
        const zip     = new AdmZip(zipPath);
        const zipEntry = zip.getEntry(`songs/${entry.mp3Name}`);
        if (!zipEntry) return res.status(404).json({ error: 'Song not in archive.' });

        const data = zip.readFile(zipEntry);
        res.setHeader('Content-Type',        'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.mp3Name)}"`);
        res.setHeader('Content-Length',      data.length);
        res.send(data);
    } catch (err) {
        // Fallback: redirect to whole-zip download if adm-zip is unavailable
        console.warn('[SONG] adm-zip unavailable, falling back:', err.message);
        res.redirect(`/file/${encodeURIComponent(session.zipFile)}`);
    }
});

/* ── Serve cover image from ZIP ───────────────────────────────────────────── */
app.get('/cover/:sessionId/:index', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).end();

    const idx   = parseInt(req.params.index, 10);
    const entry = session.entries[idx];
    if (!entry || !entry.hasCover) return res.status(404).end();

    const zipPath = path.resolve(downloadDir, session.zipFile);
    if (!zipPath.startsWith(path.resolve(downloadDir))) return res.status(403).end();
    if (!fs.existsSync(zipPath)) return res.status(404).end();

    try {
        const AdmZip   = require('adm-zip');
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

/* ── Health ───────────────────────────────────────────────────────────────── */
app.get('/health', (req, res) => res.json({ status:'ok', uptime:process.uptime() }));

app.use((req, res) => res.status(404).json({ error:'Not found' }));
app.use((err, req, res, next) => { console.error('[UNHANDLED]', err); res.status(500).json({ error:'Internal server error' }); });

// ─── Start / shutdown ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));

function shutdown(sig) {
    console.log(`\n${sig} — shutting down…`);
    server.close(() => { console.log('✅ Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM',            () => shutdown('SIGTERM'));
process.on('SIGINT',             () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => console.error('[UNCAUGHT]',  err));
process.on('unhandledRejection', reason => console.error('[UNHANDLED]', reason));