'use client';

import { motion, Variants } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Activity, ArrowRight, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';

const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.1,
            delayChildren: 0.2,
        },
    },
};

const itemVariants: Variants = {
    hidden: { opacity: 0, y: 10 },
    visible: {
        opacity: 1,
        y: 0,
        transition: {
            duration: 0.6,
            ease: [0.22, 1, 0.36, 1], // Custom cubic bezier
        },
    },
};

export function LoginForm() {
    const handleDerivConnect = async () => {
        try {
            const res = await apiFetch('/api/auth/start', { method: 'POST' });
            const data = await res.json();
            if (data?.url) {
                window.location.href = data.url;
            }
        } catch (err) {
            console.error('Failed to start OAuth flow', err);
        }
    };

    return (
        <div className="w-full max-w-sm flex flex-col items-center justify-center p-4">
            <motion.div
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                className="space-y-12 flex flex-col items-center w-full"
            >
                {/* Minimal Brand */}
                <motion.div variants={itemVariants} className="text-center space-y-6">
                    <motion.div
                        className="inline-flex p-4 rounded-full bg-card/80 backdrop-blur-md border border-border mb-2"
                        whileHover={{ scale: 1.05 }}
                    >
                        <LogoMark size={40} />
                    </motion.div>

                    <div className="space-y-2">
                        <h1 className="text-4xl font-semibold tracking-tighter text-foreground">
                            DerivNexus
                        </h1>
                        <p className="text-muted-foreground text-sm font-medium tracking-widest uppercase">
                            Algorithmic Trading Terminal
                        </p>
                    </div>
                </motion.div>

                {/* Action Button - High Contrast */}
                <motion.div variants={itemVariants} className="w-full max-w-xs space-y-6">
                    <Button
                        onClick={handleDerivConnect}
                        className="w-full h-14 rounded-full bg-accent text-accent-foreground hover:bg-accent/90 font-medium text-base tracking-wide transition-all duration-300"
                    >
                        <span>Continue with Deriv</span>
                        <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>

                    {/* Trust Indicators */}
                    <div className="flex items-center justify-center gap-6 text-muted-foreground">
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4" />
                            <span className="text-[10px] uppercase tracking-wider font-semibold">Secure</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4" />
                            <span className="text-[10px] uppercase tracking-wider font-semibold">Real-time</span>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </div>
    );
}
