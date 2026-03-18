// ─── Redis DB Client (Tier 1 Working Memory) ──────────────────────────────────
// Singleton ioredis client with connection retry and graceful shutdown.
// Degrades gracefully — all operations are no-ops when Redis is unavailable.

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const KEY_PREFIX = 'nexus:';

let redisClient: Redis | null = null;
let redisAvailable = false;
let hasLoggedError = false;  // Suppress repeated error spam

// ─── Singleton ─────────────────────────────────────────────────────────────────
function getRedis(): Redis {
    if (redisClient) return redisClient;

    redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,     // fail fast per-command
        enableReadyCheck: false,
        lazyConnect: true,           // don't auto-connect on creation
        enableOfflineQueue: false,   // immediately reject commands when offline
        retryStrategy: (times: number) => {
            if (times > 3) return null;  // stop retrying after 3 attempts
            return Math.min(times * 500, 2000);
        },
    });

    redisClient.on('connect', () => {
        redisAvailable = true;
        hasLoggedError = false;
        console.log('[Redis] Connected ✓ — working memory active');
    });

    redisClient.on('ready', () => { redisAvailable = true; });

    redisClient.on('close', () => { redisAvailable = false; });

    redisClient.on('error', () => {
        redisAvailable = false;
        if (!hasLoggedError) {
            hasLoggedError = true;
            console.warn('[Redis] Unavailable — working memory disabled. Run: docker compose up redis -d');
        }
    });

    // Connect in background — don't block server start
    redisClient.connect().catch(() => { /* handled by error event */ });

    return redisClient;
}

// ─── Init (called once at server start) ───────────────────────────────────────
export function initRedis(): void {
    getRedis(); // Trigger connection attempt
}

// ─── Safe Wrappers (no-op when Redis is unavailable) ──────────────────────────
export async function redisGet(key: string): Promise<string | null> {
    if (!redisAvailable) return null;
    try {
        return await getRedis().get(KEY_PREFIX + key);
    } catch {
        return null;
    }
}

export async function redisSet(
    key: string,
    value: string,
    ttlSeconds?: number,
): Promise<void> {
    if (!redisAvailable) return;
    try {
        const client = getRedis();
        if (ttlSeconds) {
            await client.set(KEY_PREFIX + key, value, 'EX', ttlSeconds);
        } else {
            await client.set(KEY_PREFIX + key, value);
        }
    } catch {
        // Silently drop — working memory is best-effort
    }
}

export async function redisDel(key: string): Promise<void> {
    if (!redisAvailable) return;
    try {
        await getRedis().del(KEY_PREFIX + key);
    } catch { /* ignore */ }
}

export async function redisScan(pattern: string): Promise<string[]> {
    if (!redisAvailable) return [];
    try {
        const keys: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await getRedis().scan(
                cursor,
                'MATCH',
                KEY_PREFIX + pattern,
                'COUNT',
                100,
            );
            cursor = nextCursor;
            keys.push(...batch.map((k) => k.replace(KEY_PREFIX, '')));
        } while (cursor !== '0');
        return keys;
    } catch {
        return [];
    }
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
export async function closeRedis(): Promise<void> {
    if (redisClient) {
        try { await redisClient.quit(); } catch { /* ignore */ }
        redisClient = null;
        redisAvailable = false;
        console.log('[Redis] Connection closed');
    }
}

export function isRedisAvailable(): boolean {
    return redisAvailable;
}
