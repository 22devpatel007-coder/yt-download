const express  = require('express');

const { PORT, CONCURRENCY } = require('./config');
const corsMiddleware = require('./middleware/cors');

const previewRouter = require('./routes/preview');
const formatsRouter = require('./routes/formats');
const downloadRouter = require('./routes/download');
const serveRouter = require('./routes/serve');

const app  = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.use(corsMiddleware);

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use('/preview-playlist', previewRouter);
app.use('/formats', formatsRouter);
app.use('/', downloadRouter); 
app.use('/', serveRouter);     

/* ── Health ── */
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), concurrency: CONCURRENCY }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
    console.error('[UNHANDLED]', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Start / shutdown ──────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}  (concurrency=${CONCURRENCY})`));

function shutdown(sig) {
    console.log(`\n${sig} — shutting down…`);
    server.close(() => { console.log('✅ Closed.'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGTERM',            () => shutdown('SIGTERM'));
process.on('SIGINT',             () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => console.error('[UNCAUGHT]',  err));
process.on('unhandledRejection', reason => console.error('[UNHANDLED]', reason));