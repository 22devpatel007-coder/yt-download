const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function getPlaylistTracks(url) {
    const { stdout } = await execFileAsync('spotdl', [
        'save',
        url,
        '--save-file', '-',
    ], { maxBuffer: 10 * 1024 * 1024 });

    const data = JSON.parse(stdout);
    return data.map(track => ({
        title:  track.name,
        artist: track.artist,
        cover:  track.cover_url || null,
    }));
}

module.exports = { getPlaylistTracks };
