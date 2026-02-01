'use client';

import { useState } from 'react';
import { motion, Variants, useReducedMotion } from 'framer-motion';
import { ArrowRight, ShieldCheck, Activity } from 'lucide-react';
import { Scene3D } from '@/components/three/Scene3D';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';
import { toast } from 'sonner';

export default function LoginPage() {
  const shouldReduceMotion = useReducedMotion();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const containerVariants: Variants = {
    hidden: { opacity: shouldReduceMotion ? 1 : 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: shouldReduceMotion ? 0 : 0.1,
        delayChildren: shouldReduceMotion ? 0 : 0.3,
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { y: shouldReduceMotion ? 0 : 20, opacity: shouldReduceMotion ? 1 : 0 },
    visible: {
      y: 0,
      opacity: 1,
      transition: {
        duration: shouldReduceMotion ? 0 : 0.5,
        ease: 'easeOut',
      },
    },
  };

  const handleLogin = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/auth/start', { method: 'POST' });
      if (!res.ok) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        if (res.status === 429 && Number.isFinite(retryAfter)) {
          toast.error(`Too many attempts. Try again in ${retryAfter}s.`);
        } else {
          toast.error('Auth start failed');
        }
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!data?.url) {
        toast.error('Missing OAuth URL');
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      console.error('Login failed', err);
      toast.error('Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-6 py-10 overflow-hidden">
      {/* 3D Background */}
      <Scene3D />

      {/* Main Content - No Glass Card, just floating elements */}
      <motion.div
        initial="hidden"
        animate="visible"
        variants={containerVariants}
        className="z-10 flex flex-col items-center text-center space-y-12 max-w-2xl"
      >
        {/* Logo/Brand Section */}
        <motion.div variants={itemVariants} className="space-y-4">
          <motion.div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-card/80 border border-border/60 backdrop-blur-md mb-6 shadow-soft-lg"
            whileHover={shouldReduceMotion ? undefined : { scale: 1.05 }}
          >
            <LogoMark size={36} priority />
          </motion.div>

          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight text-foreground">
            DerivNexus
          </h1>
          <p className="text-sm md:text-base text-muted-foreground uppercase tracking-[0.2em] font-light">
            Algorithmic Trading Terminal
          </p>
        </motion.div>

        {/* Action Section */}
        <motion.div variants={itemVariants} className="w-full max-w-sm space-y-8">
          <button
            onClick={handleLogin}
            disabled={isSubmitting}
            className="group relative w-full flex items-center justify-center gap-3 bg-accent text-accent-foreground px-8 py-4 rounded-xl font-semibold text-base hover:bg-accent/90 transition-all duration-300 shadow-soft-lg disabled:cursor-not-allowed disabled:opacity-70"
          >
            <span>{isSubmitting ? 'Connecting...' : 'Continue with Deriv'}</span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </button>

          <div className="flex justify-center gap-8 text-sm text-muted-foreground font-medium">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              <span>Secure OAuth 2.0</span>
            </div>
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" />
              <span>Real-time Data</span>
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={shouldReduceMotion ? { duration: 0 } : { delay: 1, duration: 1 }}
        className="absolute bottom-8 text-xs text-muted-foreground tracking-wider"
      >
        POWERED BY DERIV API
      </motion.div>
    </div>
  );
}
