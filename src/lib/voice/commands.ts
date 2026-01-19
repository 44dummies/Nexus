// Voice Command Parser for Bot Control
// Uses browser's native SpeechRecognition API

export type VoiceCommand =
    | { type: 'START_BOT' }
    | { type: 'STOP_BOT' }
    | { type: 'SET_STAKE'; amount: number }
    | { type: 'UNKNOWN' };

export function parseVoiceCommand(transcript: string): VoiceCommand {
    const text = transcript.toLowerCase().trim();

    // Start bot
    if (text.includes('start bot') || text.includes('start trading') || text.includes('begin')) {
        return { type: 'START_BOT' };
    }

    // Stop bot
    if (text.includes('stop bot') || text.includes('stop trading') || text.includes('halt') || text.includes('pause')) {
        return { type: 'STOP_BOT' };
    }

    // Set stake - "stake 5", "set stake to 10", "stake amount 25"
    const stakeMatch = text.match(/(?:stake|set stake|stake amount)(?:\s+(?:to|at))?\s+(\d+(?:\.\d+)?)/);
    if (stakeMatch) {
        const amount = parseFloat(stakeMatch[1]);
        if (Number.isFinite(amount) && amount > 0) {
            return { type: 'SET_STAKE', amount };
        }
    }

    return { type: 'UNKNOWN' };
}

// SpeechRecognition types
interface SpeechRecognitionEvent extends Event {
    results: SpeechRecognitionResultList;
    resultIndex: number;
}

interface SpeechRecognitionResultList {
    length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
    isFinal: boolean;
    length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
}

interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
}

declare global {
    interface Window {
        SpeechRecognition: new () => SpeechRecognition;
        webkitSpeechRecognition: new () => SpeechRecognition;
    }
}

export function createSpeechRecognition(): SpeechRecognition | null {
    if (typeof window === 'undefined') return null;

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    return recognition;
}
