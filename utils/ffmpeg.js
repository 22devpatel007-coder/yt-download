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

// ─── Split long text into max 2 lines of ~22 chars each ───────────────────────
function wrapText(str, maxLen = 22) {
    const words = String(str || '').trim().split(/\s+/);
    let line1 = '', line2 = '';
    for (const word of words) {
        if (!line1) { line1 = word; continue; }
        if ((line1 + ' ' + word).length <= maxLen) {
            line1 += ' ' + word;
        } else if (!line2) {
            line2 = word;
        } else if ((line2 + ' ' + word).length <= maxLen) {
            line2 += ' ' + word;
        } else {
            // truncate overflow with ellipsis
            if (line2.length < maxLen - 1) line2 += '…';
            break;
        }
    }
    return [line1, line2];
}

// ─── Escape text for ffmpeg drawtext filter ────────────────────────────────────
function escText(str) {
    return String(str || '')
        .replace(/\\/g, '/')
        .replace(/'/g, '\u2019')
        .replace(/:/g, '\\:')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

// ─── Generate black 500×500 cover with Song Name + Artist (auto-centered) ──────
async function generateBlackCover(title, artist, genre, outputPath) {
    const [titleLine1, titleLine2] = wrapText(title, 22);

    const t1 = escText(titleLine1);
    const t2 = escText(titleLine2);
    const a  = escText(artist).slice(0, 30);

    const fs    = require('fs');
    const fonts = [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/Arial.ttf',
        '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    ];
    const fontFile   = fonts.find(f => fs.existsSync(f));
    const escapedFont = fontFile
        ? fontFile.replace(/^([A-Za-z]):/, '$1\\:')
        : null;

    if (escapedFont) {
        try {
            //  Layout (500×500 canvas):
            //
            //  If title fits 1 line:
            //    title  → y=215  (centered)
            //    divider→ y=258
            //    artist → y=268
            //
            //  If title needs 2 lines:
            //    line1  → y=185
            //    line2  → y=225
            //    divider→ y=268
            //    artist → y=278
            //
            const hasTwoLines = titleLine2.length > 0;

            const layers = [
                // subtle ♪ watermark
                `drawtext=fontfile='${escapedFont}':text='♪':fontcolor=white@0.06:fontsize=200:x=(w-text_w)/2:y=(h-text_h)/2`,
            ];

            if (hasTwoLines) {
                layers.push(
                    `drawtext=fontfile='${escapedFont}':text='${t1}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=175`,
                    `drawtext=fontfile='${escapedFont}':text='${t2}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=218`,
                    `drawbox=x=125:y=264:w=250:h=1:color=white@0.3:t=fill`,
                    `drawtext=fontfile='${escapedFont}':text='${a}':fontcolor=#aaaaaa:fontsize=22:x=(w-text_w)/2:y=275`,
                );
            } else {
                layers.push(
                    `drawtext=fontfile='${escapedFont}':text='${t1}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=205`,
                    `drawbox=x=125:y=252:w=250:h=1:color=white@0.3:t=fill`,
                    `drawtext=fontfile='${escapedFont}':text='${a}':fontcolor=#aaaaaa:fontsize=22:x=(w-text_w)/2:y=263`,
                );
            }

            await execFileAsync(FFMPEG_PATH, [
                '-y',
                '-f', 'lavfi',
                '-i', 'color=c=0x111111:size=500x500:rate=1',
                '-vf', layers.join(','),
                '-frames:v', '1',
                '-f', 'image2',
                outputPath,
            ]);
            return;
        } catch (err) {
            console.warn(`[COVER] drawtext failed, fallback: ${err.message}`);
        }
    }

    // ── Fallback: plain black JPEG ────────────────────────────────────────────
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