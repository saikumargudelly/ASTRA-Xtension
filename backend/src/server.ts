import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { intentRoutes } from './routes/intent.js';
import { executeRoutes } from './routes/execute.js';
import { summarizeRoutes } from './routes/summarize.js';
import { memoryRoutes } from './routes/memory.js';
import { analyzeRoutes } from './routes/analyze.js';
import { configRoutes } from './routes/config.js';
import { orchestrateRoutes } from './routes/orchestrate.js';
import { chatRoutes } from './routes/chat.js';
import { planActionsRoute } from './routes/planActions.js';
import { getDb, closeDb } from './db/sqlite.js';
import { closeRedis } from './db/redis.js';
import { closePostgres, migrateSchema } from './db/postgres.js';

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
        service: 'nexus-backend',
        version: '1.0.0',
        features: {
            streaming: true,
            multiLLM: true,
            reactLoop: true,
            memory3Tier: true,
            critic: true,
        },
        timestamp: new Date().toISOString(),
    }));

    // ─── Routes (existing ASTRA — backward compatible) ───
    await app.register(intentRoutes);
    await app.register(executeRoutes);
    await app.register(summarizeRoutes);
    await app.register(memoryRoutes);
    await app.register(analyzeRoutes);
    await app.register(configRoutes);
    await app.register(orchestrateRoutes);

    // ─── NEXUS New Routes ───
    await app.register(chatRoutes);
    await app.register(planActionsRoute);

    // ─── Initialize Databases ───
    // SQLite (existing — always available)
    getDb();
    console.log('[NEXUS] SQLite database initialized');

    // PostgreSQL + pgvector (Tier 3 — optional, degrades gracefully)
    await migrateSchema();

    // Redis (Tier 1 — optional, degrades gracefully)
    // Redis connection is lazy — it connects on first use via getRedis()
    console.log('[NEXUS] Memory stack: SQLite ✓ | PostgreSQL (connecting...) | Redis (lazy)');

    // ─── Graceful Shutdown ───
    const shutdown = async () => {
        console.log('[NEXUS] Shutting down...');
        closeDb();
        await closeRedis();
        await closePostgres();
        await app.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // ─── Start Server ───
    try {
        await app.listen({ port: PORT, host: HOST });
        console.log(`\n  ⚡ NEXUS Backend running at http://${HOST}:${PORT}`);
        console.log(`  📡 Streaming endpoint: POST http://${HOST}:${PORT}/chat`);
        console.log(`  🔄 Legacy ASTRA routes still active for Chrome extension\n`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

start();
