const express = require('express');
const rateLimit = require('../middleware/rateLimit');
const { isValidYouTubeUrl, isValidSpotifyUrl } = require('../utils/urlValidator');
const { runDownload } = require('../engine/runDownload');

const router = express.Router();

router.get('/download-progress', rateLimit, async (req, res) => {
    const { url, spotifyToken, quality = '192' } = req.query;
    if (!url && !spotifyToken) return res.status(400).json({ error: 'No URL or token.' });
    if (url && !isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url || null, safeQ, 'structured', res, spotifyToken || null);
});

router.get('/download-flat', rateLimit, async (req, res) => {
    const { url, spotifyToken, quality = '192' } = req.query;
    if (!url && !spotifyToken) return res.status(400).json({ error: 'No URL or token.' });
    if (url && !isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url || null, safeQ, 'flat', res, spotifyToken || null);
});

router.get('/download-personal', rateLimit, async (req, res) => {
    const { url, spotifyToken, quality = '192' } = req.query;
    if (!url && !spotifyToken) return res.status(400).json({ error: 'No URL or token.' });
    if (url && !isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
    const safeQ = ['96', '128', '192', '256', '320'].includes(quality) ? quality : '192';
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await runDownload(url || null, safeQ, 'personal', res, spotifyToken || null);
});

const spotifyTokenStore = new Map();

router.post('/spotify-tracks', (req, res) => {
    const { tracks, playlistName } = req.body;
    if (!Array.isArray(tracks) || !tracks.length) return res.status(400).json({ error: 'No tracks.' });
    const token = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    spotifyTokenStore.set(token, { tracks, playlistName, createdAt: Date.now() });
    setTimeout(() => spotifyTokenStore.delete(token), 10 * 60_000);
    res.json({ token });
});
router.get('/spotify-embed', async (req, res) => {
    const { playlistId } = req.query;
    if (!playlistId || !/^[a-zA-Z0-9]+$/.test(playlistId)) {
        return res.status(400).json({ error: 'Invalid playlist ID.' });
    }
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'open.spotify.com',
                path: `/embed/playlist/${playlistId}?utm_source=generator`,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html',
                    'Accept-Language': 'en-US,en;q=0.9',
                }
            };
            https.get(options, r => {
                let body = '';
                r.on('data', c => body += c);
                r.on('end', () => resolve(body));
            }).on('error', reject);
        });
        res.setHeader('Content-Type', 'text/html');
        res.send(data);
    } catch (err) {
        res.status(500).json({ error: 'Could not reach Spotify.' });
    }
});
module.exports = { router, spotifyTokenStore };
