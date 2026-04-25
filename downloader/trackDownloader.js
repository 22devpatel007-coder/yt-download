const ytDlp = require('yt-dlp-exec');
const path  = require('path');
const fs    = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { tryUnlink }                = require('../utils/fileHelper');
const { generateBlackCover }       = require('../utils/ffmpeg');
const { FFMPEG_PATH, downloadDir } = require('../config');

// ─── Strip any embedded thumbnail from an MP3 and re-embed our cover ──────────
//
//  Why this is needed:
//    yt-dlp sometimes bakes the YouTube thumbnail into the MP3 during the
//    audio post-processing step even when embedThumbnail:false is set,
//    because some versions of yt-dlp / mutagen ignore that flag.
//
//  What this does:
//    1. Reads the downloaded MP3
//    2. Strips ALL attached picture streams (-map 0:a — audio only)
//    3. If coverPath exists, re-attaches it as APIC frame (ID3 cover art)
//    4. Overwrites the original songPath in-place
//
async function stripAndEmbedCover(songPath, coverPath) {
    const tmpOut = songPath + '.tmp.mp3';

    const args = [
        '-y',
        '-i', songPath,
    ];

    if (coverPath && fs.existsSync(coverPath)) {
        // Embed our black cover
        args.push('-i', coverPath);
        args.push('-map', '0:a');          // audio from MP3
        args.push('-map', '1:v');          // cover from our image
        args.push('-c:a', 'copy');         // no re-encode
        args.push('-c:v', 'mjpeg');        // cover codec
        args.push('-metadata:s:v', 'title=Album cover');
        args.push('-metadata:s:v', 'comment=Cover (front)');
        args.push('-id3v2_version', '3');
    } else {
        // Just strip — no cover to embed
        args.push('-map', '0:a');
        args.push('-c:a', 'copy');
        args.push('-id3v2_version', '3');
    }

    args.push(tmpOut);

    await execFileAsync(FFMPEG_PATH, args);

    // Swap tmp → original
    fs.renameSync(tmpOut, songPath);
}

// ─── Download one track (audio + black cover art) ─────────────────────────────
async function downloadTrack(entryUrl, songPath, coverPath, safeQ, needsCover, title, artist, genre) {

    // ── 1. Download audio via yt-dlp ──────────────────────────────────────────
    await ytDlp(entryUrl, {
        extractAudio:   true,
        audioFormat:    'mp3',
        audioQuality:   safeQ,
        output:         songPath,
        ffmpegLocation: FFMPEG_PATH,
        addMetadata:    true,
        embedThumbnail: false,       // tell yt-dlp not to embed — belt
        noPlaylist:     true,
        forceOverwrite: true,
        socketTimeout:  120,
        postprocessorArgs: 'ffmpeg:-map_metadata 0 -metadata comment= -metadata description= -metadata synopsis=',
    });

    // ── 2. Generate black cover with text ─────────────────────────────────────
    let hasCover = false;
    if (needsCover) {
        try {
            await generateBlackCover(title, artist, genre, coverPath);
            hasCover = fs.existsSync(coverPath);
        } catch (e) {
            console.warn(`⚠️  Black cover failed for "${title}": ${e.message}`);
        }
    }

    // ── 3. Strip any YouTube thumbnail yt-dlp snuck in + embed our cover ──────
    //
    //  This is the suspenders to embedThumbnail:false's belt.
    //  Even if yt-dlp ignored the flag, ffmpeg will strip it here
    //  and replace it with our black cover (or nothing if cover failed).
    //
    try {
        await stripAndEmbedCover(songPath, hasCover ? coverPath : null);
    } catch (e) {
        console.warn(`⚠️  stripAndEmbedCover failed for "${title}": ${e.message}`);
        // Non-fatal — MP3 is still usable, just may have wrong cover
    }

    return { hasCover };
}

module.exports = { downloadTrack };