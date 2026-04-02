const express = require('express');
const rateLimit = require('../middleware/rateLimit');
const { isValidYouTubeUrl } = require('../utils/urlValidator');
const { runDownload } = require('../engine/runDownload');

const router = express.Router();

router.get('/download-progress', rateLimit, async (req, res) => {
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

router.get('/download-flat', rateLimit, async (req, res) => {
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

router.get('/download-personal', rateLimit, async (req, res) => {
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

module.exports = router;
