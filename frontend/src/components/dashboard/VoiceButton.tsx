'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { motion } from 'framer-motion';
import { parseVoiceCommand, createSpeechRecognition } from '@/lib/voice/commands';
import { useTradingStore } from '@/store/tradingStore';

export default function VoiceButton() {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [feedback, setFeedback] = useState('');
    const recognitionRef = useRef<ReturnType<typeof createSpeechRecognition>>(null);
    const { setBotRunning, setBotConfig } = useTradingStore();

    const handleCommand = useCallback((text: string) => {
        const command = parseVoiceCommand(text);

        switch (command.type) {
            case 'START_BOT':
                setBotRunning(true);
                setFeedback('Bot Started!');
                break;
            case 'STOP_BOT':
                setBotRunning(false);
                setFeedback('Bot Stopped!');
                break;
            case 'SET_STAKE':
                setBotConfig({ baseStake: command.amount });
                setFeedback(`Stake set to $${command.amount}`);
                break;
            default:
                setFeedback('Command not recognized');
        }

        setTimeout(() => setFeedback(''), 3000);
    }, [setBotRunning, setBotConfig]);

    useEffect(() => {
        recognitionRef.current = createSpeechRecognition();

        if (recognitionRef.current) {
            recognitionRef.current.onresult = (event) => {
                const result = event.results[event.results.length - 1];
                if (result.isFinal) {
                    const text = result[0].transcript;
                    setTranscript(text);
                    handleCommand(text);
                }
            };

            recognitionRef.current.onend = () => {
                setIsListening(false);
            };

            recognitionRef.current.onerror = () => {
                setIsListening(false);
                setFeedback('Voice recognition error');
            };
        }

        return () => {
            recognitionRef.current?.abort();
        };
    }, [handleCommand]);

    const startListening = useCallback(() => {
        if (!recognitionRef.current) {
            setFeedback('Voice not supported');
            return;
        }

        setTranscript('');
        setIsListening(true);
        recognitionRef.current.start();
    }, []);

    const stopListening = useCallback(() => {
        recognitionRef.current?.stop();
        setIsListening(false);
    }, []);

    return (
        <div className="relative">
            <motion.button
                onMouseDown={startListening}
                onMouseUp={stopListening}
                onMouseLeave={stopListening}
                onTouchStart={startListening}
                onTouchEnd={stopListening}
                className={`relative p-4 rounded-full transition-all ${isListening
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-muted/40 hover:bg-muted/60 text-foreground border border-border'
                    }`}
                whileTap={{ scale: 0.95 }}
            >
                {isListening ? (
                    <>
                        <Mic className="w-6 h-6" />
                        {/* Wave animation */}
                        <motion.div
                            className="absolute inset-0 rounded-full border-2 border-accent"
                            animate={{ scale: [1, 1.5, 1], opacity: [1, 0, 1] }}
                            transition={{ duration: 1, repeat: Infinity }}
                        />
                        <motion.div
                            className="absolute inset-0 rounded-full border-2 border-accent"
                            animate={{ scale: [1, 1.8, 1], opacity: [0.5, 0, 0.5] }}
                            transition={{ duration: 1, repeat: Infinity, delay: 0.3 }}
                        />
                    </>
                ) : (
                    <MicOff className="w-6 h-6" />
                )}
            </motion.button>

            {/* Transcript & Feedback */}
            {(transcript || feedback) && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute top-full mt-2 left-1/2 -translate-x-1/2 whitespace-nowrap glass-panel px-4 py-2 rounded-lg text-sm"
                >
                    {feedback ? (
                        <span className="text-accent">{feedback}</span>
                    ) : (
                        <span className="text-muted-foreground">&quot;{transcript}&quot;</span>
                    )}
                </motion.div>
            )}
        </div>
    );
}
