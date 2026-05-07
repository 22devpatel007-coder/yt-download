const SpotifyWebApi = require('spotify-web-api-node');

const spotify = new SpotifyWebApi({
    clientId:     process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpiry = 0;

async function ensureToken() {
    if (Date.now() < tokenExpiry) return;
    const data = await spotify.clientCredentialsGrant();
    spotify.setAccessToken(data.body.access_token);
    tokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

function extractPlaylistId(url) {
    const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
}

async function getPlaylistTracks(url) {
    await ensureToken();
    const id = extractPlaylistId(url);
    if (!id) throw new Error('Invalid Spotify playlist URL');

    const tracks = [];
    let offset = 0;
    let total = 1;

    while (offset < total) {
        const res = await spotify.getPlaylistTracks(id, { limit: 100, offset });
        total = res.body.total;
        for (const item of res.body.items) {
            const t = item.track;
            if (!t) continue;
            tracks.push({
                title:  t.name,
                artist: t.artists[0].name,
                cover:  t.album.images[0]?.url || null,
            });
        }
        offset += 100;
    }

    return tracks;
}

module.exports = { getPlaylistTracks };