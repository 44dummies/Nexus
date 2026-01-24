'use client';

import Image from 'next/image';
import { useState } from 'react';
import { Zap } from 'lucide-react';

type LogoMarkProps = {
    size?: number;
    className?: string;
    priority?: boolean;
};

export function LogoMark({ size = 40, className = '', priority = false }: LogoMarkProps) {
    const [failed, setFailed] = useState(false);

    if (failed) {
        return (
            <div
                className={`rounded-2xl bg-gradient-to-br from-accent to-sky-500 flex items-center justify-center ${className}`.trim()}
                style={{ width: size, height: size }}
                aria-label="DerivNexus logo"
            >
                <Zap className="w-5 h-5 text-white" />
            </div>
        );
    }

    return (
        <Image
            src="/brand-mark.png"
            alt="DerivNexus logo"
            width={size}
            height={size}
            priority={priority}
            onError={() => setFailed(true)}
            className={`rounded-2xl ${className}`.trim()}
        />
    );
}
