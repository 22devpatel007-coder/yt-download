const rlMap = new Map();

function rateLimit(req, res, next) {
    const ip  = req.ip || req.socket.remoteAddress || 'x';
    const now = Date.now();
    const e   = rlMap.get(ip) || { count: 0, start: now };
    if (now - e.start > 60_000) { e.count = 1; e.start = now; } else e.count++;
    rlMap.set(ip, e);
    if (e.count > 15) return res.status(429).json({ error: 'Too many requests — wait a minute.' });
    next();
}

setInterval(() => {
    const cut = Date.now() - 60_000;
    for (const [ip, e] of rlMap) if (e.start < cut) rlMap.delete(ip);
}, 5 * 60_000);

module.exports = rateLimit;
