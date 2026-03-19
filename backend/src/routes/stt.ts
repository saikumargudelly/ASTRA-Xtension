import multipart, { type MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface SttSuccessResponse {
    success: true;
    transcript: string;
    duration_ms: number;
}

interface SttErrorResponse {
    success: false;
    error: string;
}

function resolveLanguage(audioPart: MultipartFile): string {
    const rawLanguage = audioPart.fields?.language;
    if (!rawLanguage || Array.isArray(rawLanguage) || !('value' in rawLanguage)) return 'en';
    const value = typeof rawLanguage.value === 'string' ? rawLanguage.value.trim() : '';
    return value || 'en';
}

async function readSttMultipart(request: FastifyRequest): Promise<{
    audioBuffer: Buffer | null;
    filename: string;
    mimetype: string;
    language: string;
}> {
    let audioBuffer: Buffer | null = null;
    let filename = 'recording.webm';
    let mimetype = 'audio/webm';
    let language = 'en';

    for await (const part of request.parts()) {
        if (part.type === 'field' && part.fieldname === 'language') {
            const value = typeof part.value === 'string' ? part.value.trim() : '';
            language = value || 'en';
            continue;
        }

        if (part.type === 'file' && part.fieldname === 'audio' && !audioBuffer) {
            audioBuffer = await part.toBuffer();
            filename = part.filename || filename;
            mimetype = part.mimetype || mimetype;
            language = resolveLanguage(part) || language;
            continue;
        }

        if (part.type === 'file') part.file.resume();
    }

    return { audioBuffer, filename, mimetype, language };
}

export async function sttRoutes(app: FastifyInstance): Promise<void> {
    await app.register(multipart);

    const model = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
    console.log(`[ASTRA STT] Groq Whisper route ready. Model: ${model}`);

    /**
     * POST /stt
     * Accepts multipart audio and returns a transcript from Groq Whisper.
     */
    app.post<{ Reply: SttSuccessResponse | SttErrorResponse }>('/stt', async (request, reply) => {
        const startedAt = Date.now();

        try {
            if (!process.env.GROQ_API_KEY) {
                return reply.status(500).send({ success: false, error: 'Missing GROQ_API_KEY' });
            }

            const { audioBuffer, filename, mimetype, language } = await readSttMultipart(request);
            if (!audioBuffer) {
                return reply.status(400).send({ success: false, error: 'Missing multipart field "audio"' });
            }

            const form = new FormData();
            form.append('file', new Blob([audioBuffer], { type: mimetype }), filename);
            form.append('model', model);
            form.append('response_format', 'json');
            form.append('language', language);

            const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
                body: form,
            });

            const payload = await groqResponse.json() as { text?: string; error?: { message?: string } };
            if (!groqResponse.ok) throw new Error(payload.error?.message || 'Groq transcription failed');

            return reply.send({
                success: true,
                transcript: payload.text || '',
                duration_ms: Date.now() - startedAt,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'STT request failed';
            return reply.status(500).send({ success: false, error: message });
        }
    });
}
