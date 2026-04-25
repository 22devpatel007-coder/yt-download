const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { FFMPEG_PATH } = require('../config');

// ─── Resize image to 500×500 JPEG via ffmpeg ───────────────────────────────────
async function resizeCover(inputPath, outputPath) {
    await execFileAsync(FFMPEG_PATH, [
        '-y',
        '-i', inputPath,
        '-vf', 'scale=500:500:force_original_aspect_ratio=decrease,pad=500:500:(ow-iw)/2:(oh-ih)/2:white',
        '-q:v', '3',
        outputPath,
    ]);
}

// ─── Generate black 500×500 cover with Song Name, Artist, Genre ───────────────
//
//  Strategy:
//    1. Try ffmpeg drawtext filter (needs a font on the system)
//    2. If drawtext fails (no font found) → fallback to plain solid black JPEG
//
//  Text is escaped for ffmpeg's drawtext syntax:
//    - Single quotes and backslashes are the only chars that break drawtext
//    - Replace them with a safe substitute before passing to ffmpeg
//
async function generateBlackCover(title, artist, genre, outputPath) {
    // Escape text for ffmpeg drawtext: ' and \ cause parse errors
    const esc = str => String(str || '')
        .replace(/\\/g, '/')
        .replace(/'/g, '\u2019')   // replace ' with right single quotation mark
        .replace(/:/g, '\\:')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .slice(0, 50);             // cap length so text fits on 500px canvas

    const t = esc(title);
    const a = esc(artist);
    const g = esc(genre);

    // ── Try drawtext (with font) ──────────────────────────────────────────────
    //
    //  Font search order (covers Windows, macOS, Linux):
    //    Windows : C:/Windows/Fonts/arial.ttf
    //    macOS   : /Library/Fonts/Arial.ttf  or  /System/Library/Fonts/Helvetica.ttc
    //    Linux   : /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
    //
    //  We try each path; use the first one that exists.
    //  If none exist → skip drawtext, go to fallback.
    //
    const fs   = require('fs');
    const fonts = [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/Arial.ttf',
        '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    ];
    const fontFile = fonts.find(f => fs.existsSync(f));

    if (fontFile) {
        try {
            //  Layout (all positions on 500×500 canvas):
            //    Song title  → y=160  (large, white)
            //    Artist name → y=240  (medium, white)
            //    Genre       → y=305  (small, gray  #aaaaaa)
            //
            //  x=(w-text_w)/2  centers text horizontally regardless of length.
            //
            const drawtext = [
                `drawtext=fontfile='${fontFile}':text='${t}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=160`,
                `drawtext=fontfile='${fontFile}':text='${a}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=240`,
                `drawtext=fontfile='${fontFile}':text='${g}':fontcolor=#aaaaaa:fontsize=18:x=(w-text_w)/2:y=305`,
            ].join(',');

            await execFileAsync(FFMPEG_PATH, [
                '-y',
                '-f', 'lavfi',
                '-i', 'color=c=black:size=500x500:rate=1',
                '-vf', drawtext,
                '-frames:v', '1',
                '-f', 'image2',
                outputPath,
            ]);
            return; // success
        } catch (err) {
            console.warn(`[COVER] drawtext failed, using plain black fallback: ${err.message}`);
        }
    }

    // ── Fallback: plain solid black JPEG (no text) ────────────────────────────
    //
    //  -f lavfi -i color=c=black generates a solid black frame.
    //  Still a valid cover image — just no text overlay.
    //
    await execFileAsync(FFMPEG_PATH, [
        '-y',
        '-f', 'lavfi',
        '-i', 'color=c=black:size=500x500:rate=1',
        '-frames:v', '1',
        '-f', 'image2',
        outputPath,
    ]);
}

module.exports = { resizeCover, generateBlackCover };