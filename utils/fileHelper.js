const fs   = require('fs');
const http = require('https');

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

// ─── Known genre keywords to match against yt-dlp tags ────────────────────────
const GENRE_KEYWORDS = [
    'pop','rock','hip hop','rap','r&b','rnb','soul','jazz','blues','classical',
    'electronic','edm','house','techno','dance','indie','alternative','metal',
    'punk','folk','country','reggae','latin','k-pop','bollywood','punjabi',
    'lofi','lo-fi','trap','drill','phonk','ambient','acoustic','gospel',
    'funk','disco','swing','opera','orchestra','synthwave','retrowave',
];

// ─── Extract genre from yt-dlp entry metadata ─────────────────────────────────
//
//  Priority:
//    1. entry.genre          — set by some uploaders in video metadata
//    2. entry.categories     — YouTube category e.g. ["Music"]  (too broad, skip "Music" alone)
//    3. entry.tags           — match against known genre keywords
//    4. entry.description    — last resort keyword scan
//    5. 'Unknown'
//
function extractGenre(entry) {
    // 1. explicit genre field
    if (entry.genre && entry.genre.trim() && entry.genre.trim().toLowerCase() !== 'unknown') {
        return capitalize(entry.genre.trim());
    }

    // 2. categories — skip generic "Music", use specific ones like "Pop Music"
    const cats = entry.categories || [];
    for (const cat of cats) {
        const c = (cat || '').toLowerCase().trim();
        if (c && c !== 'music' && c !== 'entertainment') {
            return capitalize(cat.trim());
        }
    }

    // 3. tags — scan for known genre keywords
    const tags = entry.tags || [];
    for (const tag of tags) {
        const t = (tag || '').toLowerCase().trim();
        for (const kw of GENRE_KEYWORDS) {
            if (t === kw || t.includes(kw)) {
                return capitalize(tag.trim());
            }
        }
    }

    // 4. description keyword scan (last resort)
    const desc = (entry.description || '').toLowerCase();
    for (const kw of GENRE_KEYWORDS) {
        if (desc.includes(kw)) {
            return capitalize(kw);
        }
    }

    return 'Unknown';
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ─── fetchGenre — kept for API compatibility with runDownload.js ───────────────
//  Now uses yt-dlp entry data instead of external API calls.
//  Pass the full yt-dlp entry object as third argument.
//
function fetchGenre(title, artist, entry) {
    if (entry) return Promise.resolve(extractGenre(entry));
    return Promise.resolve('Unknown');
}

module.exports = { safeName, tryUnlink, getEntryUrl, fmtDuration, fetchGenre, extractGenre };