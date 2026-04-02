function isValidYouTubeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const p = new URL(url);
        return ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com']
            .includes(p.hostname);
    } catch { return false; }
}

module.exports = { isValidYouTubeUrl };
