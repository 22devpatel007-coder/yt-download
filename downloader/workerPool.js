async function runWorkerPool(entries, concurrency, res, processEntry) {
    for (let i = 0; i < entries.length; i += concurrency) {
        if (res.destroyed || res.writableEnded) break;
        await Promise.all(
            entries.slice(i, i + concurrency).map((v, j) => processEntry(v, i + j))
        );
    }
}

module.exports = { runWorkerPool };
