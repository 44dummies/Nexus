'use client';

import { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface GlassCardProps {
    children: ReactNode;
    className?: string;
}

export function GlassCard({ children, className }: GlassCardProps) {
    const shouldReduceMotion = useReducedMotion();
    return (
        <motion.div
            initial={shouldReduceMotion ? false : { opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={shouldReduceMotion ? { duration: 0 } : {
                duration: 0.8,
                ease: [0.16, 1, 0.3, 1]
            }}
            className={cn(
                // Base glassmorphism - Frosted Glass
                'relative overflow-hidden rounded-3xl',
                'bg-card/90 backdrop-blur-md',
                'border border-border/70',
                'shadow-soft-lg',
                'transition-all duration-500',
                className
            )}
        >
            {/* Subtle top highlight */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent opacity-60" />

            {/* Content */}
            <div className="relative z-10">
                {children}
            </div>
        </motion.div>
    );
}
