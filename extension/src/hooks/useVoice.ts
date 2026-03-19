import { useRef, useState } from 'react';
import { BACKEND_URL } from '../config';

interface SttSuccessResponse {
    success: true;
    transcript: string;
    duration_ms: number;
}

interface SttErrorResponse {
    success: false;
    error: string;
}

type SttResponse = SttSuccessResponse | SttErrorResponse;

interface UseVoiceResult {
    isRecording: boolean;
    isProcessing: boolean;
    error: string | null;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
}

type RecordingMode = 'popup' | 'tab';

interface TabMicResponse {
    success: boolean;
    transcript?: string;
    audioBase64?: string;
    mimeType?: string;
    filename?: string;
    error?: string;
    code?: string;
}

interface TabMicStartResult {
    success: boolean;
    error?: string;
}

interface SttLooseResponse {
    success?: boolean;
    transcript?: string;
    error?: string;
}

type TranscriptHandler = (text: string) => void;

export function useVoice(onTranscript: TranscriptHandler): UseVoiceResult {
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<BlobPart[]>([]);
    const recordingModeRef = useRef<RecordingMode | null>(null);

    const stopTracks = () => {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
    };

    const base64ToBlob = (base64: string, mimeType: string): Blob => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
    };

    const normalizeTranscriptionError = (error: unknown): string => {
        if (error instanceof Error && /failed to fetch/i.test(error.message)) {
            return `Failed to reach backend at ${BACKEND_URL}/stt. Start backend and verify CORS.`;
        }
        return error instanceof Error ? error.message : 'Failed to transcribe audio';
    };

    const transcribeAudioBlob = async (audioBlob: Blob): Promise<string> => {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        const response = await fetch(`${BACKEND_URL}/stt`, {
            method: 'POST',
            body: formData,
        });

        const rawText = await response.text();
        let payload: SttLooseResponse = {};
        if (rawText) {
            try {
                payload = JSON.parse(rawText) as SttLooseResponse;
            } catch {
                payload = { error: rawText };
            }
        }

        if (!response.ok || !payload.success) {
            throw new Error(payload.error || `STT request failed (${response.status})`);
        }

        return payload.transcript || '';
    };

    const sendTabMicMessage = async (
        type: 'ASTRA_MIC_START' | 'ASTRA_MIC_STOP',
    ): Promise<TabMicResponse> => {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tabId = tabs[0]?.id;
            if (!tabId) {
                return { success: false, error: 'No active tab found for microphone access', code: 'NO_ACTIVE_TAB' };
            }

            const message = type === 'ASTRA_MIC_STOP'
                ? { type }
                : { type };

            const response = await chrome.tabs.sendMessage(tabId, message) as TabMicResponse | undefined;
            return response || { success: false, error: 'No response from content script. Refresh page and try again.', code: 'NO_RESPONSE' };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Mic capture message failed';
            if (typeof message === 'string' && message.includes('Receiving end does not exist')) {
                return {
                    success: false,
                    error: 'Active tab is not ready for mic capture. Refresh the tab and try again.',
                    code: 'NO_CONTENT_SCRIPT',
                };
            }
            if (typeof message === 'string' && message.includes('Cannot access a chrome:// URL')) {
                return {
                    success: false,
                    error: 'Mic capture is not supported on chrome:// pages. Open a normal website tab and retry.',
                    code: 'RESTRICTED_TAB',
                };
            }
            return { success: false, error: message, code: 'MESSAGE_FAILED' };
        }
    };

    const startRecordingInActiveTab = async (): Promise<TabMicStartResult> => {
        const result = await sendTabMicMessage('ASTRA_MIC_START');
        if (!result.success) {
            return { success: false, error: result.error || 'Failed to start microphone in active tab' };
        }
        recordingModeRef.current = 'tab';
        setIsRecording(true);
        return { success: true };
    };

    const startRecording = async () => {
        if (isRecording || isProcessing) return;
        setError(null);

        // Primary path: content-script mic capture in active tab (trusted tab context).
        const tabStart = await startRecordingInActiveTab();
        if (tabStart.success) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            chunksRef.current = [];

            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            mediaRecorderRef.current = recorder;

            recorder.ondataavailable = (event: BlobEvent) => {
                if (event.data.size > 0) chunksRef.current.push(event.data);
            };

            recorder.onstop = async () => {
                const outputType = recorder.mimeType || 'audio/webm';
                const audioBlob = new Blob(chunksRef.current, { type: outputType });
                stopTracks();

                if (audioBlob.size === 0) {
                    setError('No audio captured');
                    setIsRecording(false);
                    return;
                }

                setIsRecording(false);
                setIsProcessing(true);

                try {
                    const transcript = await transcribeAudioBlob(audioBlob);
                    onTranscript(transcript);
                } catch (sttError) {
                    setError(normalizeTranscriptionError(sttError));
                } finally {
                    recordingModeRef.current = null;
                    chunksRef.current = [];
                    setIsProcessing(false);
                }
            };

            recorder.start();
            recordingModeRef.current = 'popup';
            setIsRecording(true);
        } catch (streamError) {
            stopTracks();

            const isDenied = streamError instanceof DOMException
                && (streamError.name === 'NotAllowedError' || streamError.name === 'PermissionDeniedError');
            const secureContextMissing = !window.isSecureContext || !navigator.mediaDevices;

            let popupMessage: string;

            if (secureContextMissing) {
                popupMessage = 'Popup context is not secure for microphone access.';
            } else if (isDenied) {
                popupMessage = 'Popup microphone permission denied.';
            } else {
                popupMessage = 'Popup microphone access failed.';
            }

            const combined = tabStart.error
                ? `${tabStart.error} ${popupMessage}`
                : popupMessage;

            setError(combined.trim());

            setIsRecording(false);
        }
    };

    const stopRecording = () => {
        if (recordingModeRef.current === 'tab') {
            setIsRecording(false);
            setIsProcessing(true);

            void (async () => {
                try {
                    const result = await sendTabMicMessage('ASTRA_MIC_STOP');
                    if (!result.success) {
                        setError(result.error || 'Failed to stop microphone recording');
                        return;
                    }
                    if (!result.audioBase64) {
                        setError('No audio data returned from active tab recording');
                        return;
                    }

                    const mimeType = result.mimeType || 'audio/webm';
                    const audioBlob = base64ToBlob(result.audioBase64, mimeType);
                    const transcript = await transcribeAudioBlob(audioBlob);
                    onTranscript(transcript);
                } catch (tabStopError) {
                    setError(normalizeTranscriptionError(tabStopError));
                } finally {
                    recordingModeRef.current = null;
                    setIsProcessing(false);
                }
            })();
            return;
        }

        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state === 'inactive') return;
        recorder.stop();
    };

    return {
        isRecording,
        isProcessing,
        error,
        startRecording,
        stopRecording,
    };
}
