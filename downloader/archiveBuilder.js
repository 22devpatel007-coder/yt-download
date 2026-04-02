const archiver = require('archiver');
const fs = require('fs');

function setupArchive(zipPath, send, res) {
    const writeStream = fs.createWriteStream(zipPath);
    const archive     = archiver('zip', { store: true });

    archive.on('error', err => {
        console.error('[ARCHIVE]', err.message);
        send({ error: true, message: 'Archive failed.' });
        if (!res.writableEnded) res.end();
    });
    archive.pipe(writeStream);

    let archiveQueue = Promise.resolve();
    const addToArchive = fn => { archiveQueue = archiveQueue.then(fn); return archiveQueue; };

    const finalizeArchive = async () => {
        await archiveQueue; // block until queue flows
        return new Promise((resolve, reject) => {
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
            archive.finalize();
        });
    };

    return { archive, addToArchive, finalizeArchive };
}

module.exports = { setupArchive };
