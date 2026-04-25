const fs    = require('fs');
const https = require('https');

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

// ─── Simple HTTPS GET helper ───────────────────────────────────────────────────
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'YT-MP3-Downloader/1.0 (local-use)',
                'Accept':     'application/json',
            },
            timeout: 6000,
        }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('JSON parse failed')); }
            });
        });
        req.on('error',   reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ─── Capitalise first letter ───────────────────────────────────────────────────
function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ─── Pick best tag from a tags array ──────────────────────────────────────────
function bestTag(tags) {
    if (!tags || !tags.length) return null;
    // Filter out useless meta-tags
    const skip = new Set(['seen live', 'favorite', 'good', 'great', 'awesome', 'music']);
    const filtered = tags
        .filter(t => t.name && !skip.has(t.name.toLowerCase()))
        .sort((a, b) => (b.count || 0) - (a.count || 0));
    return filtered.length ? cap(filtered[0].name) : null;
}

// ─── Fetch real genre from MusicBrainz API ────────────────────────────────────
//
//  Strategy (most → least specific):
//    1. Search recordings by cleaned title + artist
//    2. Check recording-level tags on top 5 results
//    3. If no recording tags → follow release-group MBID for release-group tags
//    4. If still nothing → resolve 'Unknown'
//
async function fetchGenre(title, artist) {
    try {
        // Strip bracketed extras: "(Lyrics)", "[Official Video]", "(feat. X)" etc.
        const strip = s => String(s || '')
            .replace(/[\(\[\{][^\)\]\}]{0,40}[\)\]\}]/g, '')
            .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const cleanTitle  = strip(title);
        const cleanArtist = strip(artist);

        if (!cleanTitle) return 'Unknown';

        // ── Step 1: Search recordings ─────────────────────────────────────────
        const query = encodeURIComponent(`${cleanTitle} artist:${cleanArtist}`);
        const searchUrl = `https://musicbrainz.org/ws/2/recording?query=${query}&limit=5&fmt=json&inc=tags+releases`;

        let data;
        try { data = await httpsGet(searchUrl); }
        catch { return 'Unknown'; }

        const recordings = data.recordings || [];
        if (!recordings.length) return 'Unknown';

        // ── Step 2: Check recording-level tags ────────────────────────────────
        for (const rec of recordings) {
            const tag = bestTag(rec.tags);
            if (tag) return tag;
        }

        // ── Step 3: Follow release-group for genre tags ───────────────────────
        //
        //  Release groups have genre/tag data more reliably than recordings.
        //  Grab the first release's release-group MBID from the top recording.
        //
        const releases = recordings[0].releases || [];
        const rgId = releases[0]?.['release-group']?.id;

        if (rgId) {
            try {
                const rgUrl  = `https://musicbrainz.org/ws/2/release-group/${rgId}?inc=tags+genres&fmt=json`;
                const rgData = await httpsGet(rgUrl);

                // Prefer genres[] (newer MB field) over tags[]
                const fromGenres = bestTag(rgData.genres);
                if (fromGenres) return fromGenres;

                const fromTags = bestTag(rgData.tags);
                if (fromTags) return fromTags;
            } catch { /* ignore, fall through */ }
        }

        return 'Unknown';

    } catch {
        return 'Unknown';
    }
}

module.exports = { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre };