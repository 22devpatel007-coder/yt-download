const fs = require('fs');

function buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath) {
    const mapEntry = (entry, includeCovers) => ({
        file:    entry.file,
        title:   entry.title,
        artist:  entry.artist,
        ...(entry.tags?.length ? { tags: entry.tags }         : {}),
        ...(entry.duration     ? { duration: entry.duration } : {}),
        ...(includeCovers && entry.cover ? { cover: entry.cover } : {}),
    });

    if (mode === 'structured') {
        archive.append(
            Buffer.from(JSON.stringify(manifest.map(e => mapEntry(e, true)), null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
    } else if (mode === 'flat') {
        archive.append(
            Buffer.from(JSON.stringify(manifest.map(e => ({
                ...mapEntry(e, false),
                file: e.file.replace('songs/', ''),
            })), null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
    } else if (mode === 'personal') {
        const personalManifest = {
            name:        albumName,
            description: info.description ? info.description.slice(0, 500) : '',
            ...(playlistCoverPath ? { cover: 'playlist-cover.jpg' } : {}),
            songs: manifest.map(e => mapEntry(e, true)),
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