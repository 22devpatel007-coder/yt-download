const fs   = require('fs');
const http  = require('https'); // built-in Node.js — no install needed

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
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '00')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Fetch real genre from MusicBrainz API ─────────────────────────────────────
//
//  Flow:
//    1. Search MusicBrainz recordings by title + artist
//    2. Look at the top result's tags (sorted by count desc)
//    3. Return the highest-voted tag as genre string
//    4. If nothing found → return 'Unknown'
//
//  MusicBrainz requires a descriptive User-Agent (their policy).
//  We use a 5 second timeout so a slow API never blocks the download.
//
function fetchGenre(title, artist) {
    return new Promise(resolve => {
        // Sanitise query — strip characters MusicBrainz Lucene dislikes
        const clean = s => String(s || '').replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').trim();
        const query = encodeURIComponent(`recording:"${clean(title)}" AND artist:"${clean(artist)}"`);
        const url   = `https://musicbrainz.org/ws/2/recording?query=${query}&limit=1&fmt=json`;

        const req = http.get(url, {
            headers: {
                'User-Agent': 'YT-MP3-Downloader/1.0 (local-use)',
                'Accept':     'application/json',
            },
            timeout: 5000,
        }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try {
                    const data       = JSON.parse(raw);
                    const recordings = data.recordings || [];
                    if (!recordings.length) return resolve('Unknown');

                    // Tags are on the recording itself
                    const tags = (recordings[0].tags || [])
                        .sort((a, b) => (b.count || 0) - (a.count || 0));

                    if (tags.length) {
                        // Capitalise first letter of genre
                        const genre = tags[0].name.charAt(0).toUpperCase() + tags[0].name.slice(1);
                        return resolve(genre);
                    }
                    resolve('Unknown');
                } catch {
                    resolve('Unknown');
                }
            });
        });

        req.on('error',   () => resolve('Unknown'));
        req.on('timeout', () => { req.destroy(); resolve('Unknown'); });
    });
}

module.exports = { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre };