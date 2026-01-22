'use client';

import { Bot } from 'lucide-react';

export function BotsHeader() {
    return (
        <div className="mb-8">
            <h1 className="text-3xl font-bold flex items-center gap-3">
                <Bot className="w-8 h-8 text-accent" />
                Bot Hub
            </h1>
            <p className="text-muted-foreground mt-2">
                Curated strategies with disciplined risk controls
            </p>
        </div>
    );
}
