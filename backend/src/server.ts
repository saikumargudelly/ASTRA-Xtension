import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { intentRoutes } from './routes/intent.js';
import { executeRoutes } from './routes/execute.js';
import { summarizeRoutes } from './routes/summarize.js';
import { memoryRoutes } from './routes/memory.js';
import { analyzeRoutes } from './routes/analyze.js';
import { getDb, closeDb } from './db/sqlite.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
    const app = Fastify({
        logger: {
            level: 'info',
            transport: {
                target: 'pino-pretty',
                options: { colorize: true },
            },
        },
    });

    // ─── CORS ───
    await app.register(cors, {
        origin: [
            'chrome-extension://*',
            'http://localhost:*',
        ],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
    });

    // ─── Health Check ───
    app.get('/health', async () => ({
        status: 'ok',
        service: 'astra-backend',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
    }));

    // ─── Routes ───
    await app.register(intentRoutes);
    await app.register(executeRoutes);
    await app.register(summarizeRoutes);
    await app.register(memoryRoutes);
    await app.register(analyzeRoutes);

    // ─── Initialize Database ───
    getDb();
    console.log('[ASTRA] SQLite database initialized');

    // ─── Graceful Shutdown ───
    const shutdown = async () => {
        console.log('[ASTRA] Shutting down...');
        closeDb();
        await app.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // ─── Start Server ───
    try {
        await app.listen({ port: PORT, host: HOST });
        console.log(`\n  ⚡ ASTRA Backend running at http://${HOST}:${PORT}\n`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

start();
