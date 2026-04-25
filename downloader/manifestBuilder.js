const fs = require('fs');

function buildManifest(archive, mode, manifest, albumName, info, playlistCoverPath) {
    if (mode === 'structured') {
        const structuredManifest = manifest.map(entry => ({
            file:     entry.file,
            cover:    entry.cover,
            title:    entry.title,
            artist:   entry.artist,
            genre:    entry.genre,
            duration: entry.duration,
        }));
        archive.append(
            Buffer.from(JSON.stringify(structuredManifest, null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
    } else if (mode === 'flat') {
        const flatManifest = manifest.map(entry => ({
            file:     entry.file.replace('songs/', ''),
            title:    entry.title,
            artist:   entry.artist,
            genre:    entry.genre,
            duration: entry.duration,
        }));
        archive.append(
            Buffer.from(JSON.stringify(flatManifest, null, 2), 'utf-8'),
            { name: 'manifest.json' }
        );
    } else if (mode === 'personal') {
        const personalManifest = {
            name:        albumName,
            description: info.description ? info.description.slice(0, 500) : '',
            ...(playlistCoverPath ? { cover: 'playlist-cover.jpg' } : {}),
            songs: manifest.map(entry => ({
                file:     entry.file,
                cover:    entry.cover,
                title:    entry.title,
                artist:   entry.artist,
                genre:    entry.genre,
                duration: entry.duration,
            })),
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