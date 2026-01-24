'use client';

import { motion, Variants } from 'framer-motion';
import { ArrowRight, ShieldCheck, Activity } from 'lucide-react';
import { Scene3D } from '@/components/three/Scene3D';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';

// Animation Variants
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.3,
    },
  },
};

const itemVariants: Variants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: {
      duration: 0.5,
      ease: 'easeOut',
    },
  },
};

export default function LoginPage() {
  const handleLogin = () => {
    apiFetch('/api/auth/start', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error('Auth start failed');
        }
        const data = await res.json();
        if (!data?.url) {
          throw new Error('Missing OAuth URL');
        }
        window.location.href = data.url;
      })
      .catch((err) => {
        console.error('Login failed', err);
      });
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
            whileHover={{ scale: 1.05 }}
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
            className="group relative w-full flex items-center justify-center gap-3 bg-accent text-accent-foreground px-8 py-4 rounded-xl font-semibold text-base hover:bg-accent/90 transition-all duration-300 shadow-soft-lg"
          >
            <span>Continue with Deriv</span>
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
        transition={{ delay: 1, duration: 1 }}
        className="absolute bottom-8 text-xs text-muted-foreground tracking-wider"
      >
        POWERED BY DERIV API
      </motion.div>
    </div>
  );
}
