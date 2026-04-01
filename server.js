const express = require('express');
const ytDlp = require('yt-dlp-exec');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = 3030;

// ✅ IMPORTANT: full path to ffmpeg.exe
const FFMPEG_PATH = "C:/ffmpeg-2026-03-30-git-e54e117998-essentials_build/bin/ffmpeg.exe";

app.use(express.json());
app.use(express.static('public'));

const downloadDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);



/* =========================
   🎬 PREVIEW
========================= */
app.post('/preview', async (req, res) => {
    const { url } = req.body;

    try {
        const info = await ytDlp(url, { dumpSingleJson: true });

        res.json({
            title: info.title,
            artist: info.uploader,
            thumbnail: info.thumbnail
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Preview failed");
    }
});



/* =========================
   🎯 FORMATS
========================= */
app.post('/formats', async (req, res) => {
    try {
        const info = await ytDlp(req.body.url, { dumpSingleJson: true });

        const formats = info.formats
            .filter(f => f.abr && f.filesize)
            .map(f => ({
                abr: Math.round(f.abr),
                size: (f.filesize / (1024 * 1024)).toFixed(2) + " MB"
            }))
            .sort((a, b) => b.abr - a.abr)
            .slice(0, 5);

        res.json(formats);

    } catch (err) {
        console.error(err);
        res.status(500).send("Formats error");
    }
});



/* =========================
   📊 DOWNLOAD (SINGLE + PLAYLIST)
========================= */
app.get('/download-progress', async (req, res) => {
    const url = req.query.url;
    const quality = req.query.quality || "192";

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const info = await ytDlp(url, { dumpSingleJson: true });

        const entries = info.entries || [info];
        const albumName = (info.title || "your-songs").replace(/[<>:"/\\|?*]+/g, '');

        const zipPath = path.join(downloadDir, `${albumName}.zip`);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(fs.createWriteStream(zipPath));

        let manifest = [];

        for (let i = 0; i < entries.length; i++) {

            const v = entries[i];
            const index = String(i + 1).padStart(2, '0');

            const title = (v.title || "unknown").replace(/[<>:"/\\|?*]+/g, '');
            const artist = v.uploader || "Unknown";

            const baseName = `${index} - ${title}`;
            const mp3Name = `${baseName}.mp3`;
            const coverName = `${baseName}.jpg`;

            const songPath = path.join(downloadDir, mp3Name);
            const coverPath = path.join(downloadDir, coverName);

            // 🧹 remove old file (fix access denied)
            if (fs.existsSync(songPath)) {
                try { fs.unlinkSync(songPath); } catch {}
            }

            // 📊 progress update
            res.write(`data: ${JSON.stringify({
                percent: ((i / entries.length) * 100).toFixed(1),
                size: `${i + 1}/${entries.length}`
            })}\n\n`);

            console.log(`⬇️ Downloading: ${title}`);

            /* ========= AUDIO DOWNLOAD ========= */
            await ytDlp(v.url || v.webpage_url, {
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: quality,
                output: songPath,
                ffmpegLocation: FFMPEG_PATH,
                addMetadata: true,
                embedThumbnail: true,
                noPlaylist: true,
                forceOverwrite: true
            });

            /* ========= THUMBNAIL ========= */
            try {
                await ytDlp(v.url || v.webpage_url, {
                    skipDownload: true,
                    writeThumbnail: true,
                    convertThumbnails: 'jpg',
                    output: path.join(downloadDir, baseName),
                    ffmpegLocation: FFMPEG_PATH,
                    noPlaylist: true
                });

                const files = fs.readdirSync(downloadDir);
                const thumb = files.find(f => f.startsWith(baseName) && f.endsWith('.jpg'));

                if (thumb) {
                    fs.renameSync(path.join(downloadDir, thumb), coverPath);
                }

            } catch {
                console.log("⚠️ Thumbnail skipped");
            }

            /* ========= ADD TO ZIP ========= */
            archive.file(songPath, { name: `songs/${mp3Name}` });

            if (fs.existsSync(coverPath)) {
                archive.file(coverPath, { name: `covers/${coverName}` });
            }

            manifest.push({
                file: mp3Name,
                title,
                artist,
                genre: "Unknown",
                duration: v.duration || 0
            });

            // 🧹 cleanup
            if (fs.existsSync(songPath)) fs.unlinkSync(songPath);
            if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
        }

        /* ========= MANIFEST ========= */
        const manifestPath = path.join(downloadDir, `${albumName}-manifest.json`);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        archive.file(manifestPath, { name: 'manifest.json' });

        await archive.finalize();

        res.write(`data: ${JSON.stringify({
            done: true,
            fileName: `${albumName}.zip`
        })}\n\n`);

        res.end();

    } catch (err) {
        console.error(err);
        res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
        res.end();
    }
});



/* =========================
   📥 FILE DOWNLOAD
========================= */
app.get('/file/:name', (req, res) => {
    const filePath = path.join(downloadDir, req.params.name);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send("File not found");
    }
});



/* =========================
   🚀 START SERVER
========================= */
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});