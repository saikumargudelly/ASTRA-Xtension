// ─── SSE Streaming Helper ─────────────────────────────────────────────────────
// Typed event types for real-time streaming to clients.
// Used by the /chat endpoint and WebSocket handler.

import type { FastifyReply } from 'fastify';

// ─── Event Types ───────────────────────────────────────────────────────────────
export type StreamEvent =
    | { type: 'thinking'; text: string }          // Agent's reasoning step
    | { type: 'action'; agent: string; action: string; params?: unknown } // What agent is doing
    | { type: 'token'; text: string }             // Streamed response token
    | { type: 'result'; data: unknown }           // Structured result from an agent
    | { type: 'agent_start'; agent: string }      // An agent began executing
    | { type: 'agent_done'; agent: string; durationMs: number }  // Agent finished
    | { type: 'error'; message: string }          // Error occurred
    | { type: 'done' };                           // Stream complete

// ─── SSE Helper ───────────────────────────────────────────────────────────────
export function setupSSE(reply: FastifyReply): void {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
}

export function writeSSEEvent(reply: FastifyReply, event: StreamEvent): void {
    const data = JSON.stringify(event);
    reply.raw.write(`data: ${data}\n\n`);
}

export function endSSEStream(reply: FastifyReply): void {
    reply.raw.write('data: {"type":"done"}\n\n');
    reply.raw.end();
}

// ─── Async Generator → SSE ────────────────────────────────────────────────────
export async function pipeToSSE(
    reply: FastifyReply,
    generator: AsyncGenerator<StreamEvent>,
): Promise<void> {
    setupSSE(reply);
    try {
        for await (const event of generator) {
            writeSSEEvent(reply, event);
            if (event.type === 'done') break;
        }
    } catch (err) {
        writeSSEEvent(reply, {
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
        });
    } finally {
        reply.raw.end();
    }
}

// ─── In-Memory Event Emitter (for orchestrator) ───────────────────────────────
export class StreamEmitter {
    private listeners: Array<(event: StreamEvent) => void> = [];
    private buffer: StreamEvent[] = [];
    private done = false;

    emit(event: StreamEvent): void {
        this.buffer.push(event);
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    subscribe(listener: (event: StreamEvent) => void): () => void {
        // Replay buffered events
        for (const event of this.buffer) {
            listener(event);
        }
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        let resolve: (value: StreamEvent) => void;
        const queue: StreamEvent[] = [...this.buffer];

        const unsubscribe = this.subscribe((event) => {
            queue.push(event);
            if (resolve) resolve(queue.shift()!);
        });

        try {
            while (true) {
                if (queue.length > 0) {
                    const event = queue.shift()!;
                    yield event;
                    if (event.type === 'done') return;
                } else {
                    const next = await new Promise<StreamEvent>((r) => { resolve = r; });
                    yield next;
                    if (next.type === 'done') return;
                }
            }
        } finally {
            unsubscribe();
        }
    }
}
