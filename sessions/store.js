const path = require('path');
const { downloadDir } = require('../config');
const { tryUnlink } = require('../utils/fileHelper');

// ─── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();
setInterval(() => {
    const cut = Date.now() - 30 * 60_000;
    for (const [id, s] of sessions) {
        if (s.createdAt < cut) {
            if (s.zipFile)         tryUnlink(path.join(downloadDir, s.zipFile));
            if (s.flatZipFile)     tryUnlink(path.join(downloadDir, s.flatZipFile));
            if (s.personalZipFile) tryUnlink(path.join(downloadDir, s.personalZipFile));
            sessions.delete(id);
        }
    }
}, 10 * 60_000);

module.exports = sessions;
