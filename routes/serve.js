const express = require('express');
const path = require('path');
const fs = require('fs');
const { downloadDir } = require('../config');
const sessions = require('../sessions/store');

let AdmZip;
try { AdmZip = require('adm-zip'); } catch (e) {
    console.warn('[WARN] adm-zip not installed — per-song download will fall back to ZIP redirect.');
}

const router = express.Router();

router.get('/file/:name', (req, res) => {
    const safe = path.basename(req.params.name);
    const fp   = path.resolve(downloadDir, safe);
    if (!fp.startsWith(path.resolve(downloadDir))) return res.status(403).send('Forbidden');
    if (!fs.existsSync(fp)) return res.status(404).send('File not found or already deleted.');
    res.download(fp);
});

router.get('/song/:sessionId/:index', (req, res) => {
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

router.get('/cover/:sessionId/:index', (req, res) => {
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

router.get('/playlist-cover/:sessionId', (req, res) => {
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

module.exports = router;
