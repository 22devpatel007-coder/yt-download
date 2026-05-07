const https = require('https');

let mbQueue = Promise.resolve();
const DELAY = 1100;

function get(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'yt-mp3-downloader/1.0' } }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        }).on('error', reject);
    });
}

function lookupArtist(title) {
    const result = mbQueue.then(async () => {
        await new Promise(r => setTimeout(r, DELAY));
        try {
            const q = encodeURIComponent(`recording:"${title}"`);
            const data = await get(`https://musicbrainz.org/ws/2/recording?query=${q}&limit=1&fmt=json`);
            return data?.recordings?.[0]?.['artist-credit']?.[0]?.artist?.name || null;
        } catch { return null; }
    });
    mbQueue = result.then(() => {}, () => {});
    return result;
}

module.exports = { lookupArtist };