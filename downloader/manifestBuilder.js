const fs = require('fs');

function buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath) {
    if (mode === 'structured') {
        archive.append(
            Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
    } else if (mode === 'personal') {
        const personalManifest = {
            name:        albumName,
            description: info.description ? info.description.slice(0, 500) : '',
            ...(playlistCoverPath ? { cover: 'playlist-cover.jpg' } : {}),
            songs: manifest,
        };
        archive.append(
            Buffer.from(JSON.stringify(personalManifest, null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
        if (playlistCoverPath && fs.existsSync(playlistCoverPath)) {
            archive.file(playlistCoverPath, { name: 'playlist-cover.jpg', store: true });
        }
    }
}

module.exports = { buildManifest };
