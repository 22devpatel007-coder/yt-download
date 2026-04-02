const express = require('express');
const ytDlp = require('yt-dlp-exec');
const rateLimit = require('../middleware/rateLimit');
const { isValidYouTubeUrl } = require('../utils/urlValidator');

const router = express.Router();

router.post('/', rateLimit, async (req, res) => {
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

module.exports = router;
