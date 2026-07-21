const express = require('express');
const ytDlp = require('yt-dlp-exec');
const rateLimit = require('../middleware/rateLimit');
const { isValidYouTubeUrl, isValidSpotifyUrl } = require('../utils/urlValidator');
const { getPlaylistTracks } = require('../utils/spotify');

const router = express.Router();

router.post('/', rateLimit, async (req, res) => {
    const { url } = req.body;
    if (!isValidYouTubeUrl(url) && !isValidSpotifyUrl(url)) return res.status(400).json({ error: 'Invalid URL.' });
try {
    if (isValidSpotifyUrl(url)) {
        const tracks = await getPlaylistTracks(url);
        const first  = tracks[0];
        res.json({
            title:      'Spotify Playlist',
            artist:     first?.artist || 'Unknown',
            thumbnail:  first?.cover  || '',
            isPlaylist: true,
            trackCount: tracks.length,
        });
        return;
    }
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
        console.error('[PREVIEW]', JSON.stringify(err));
        res.status(500).json({ error: 'Could not fetch info.' });
    }
});

module.exports = router;
