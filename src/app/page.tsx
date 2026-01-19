'use client';

import { useRef, useEffect } from 'react';
import { motion, Variants } from 'framer-motion';
import { ArrowRight, Zap, ShieldCheck, Activity } from 'lucide-react';
import { Scene3D } from '@/components/three/Scene3D';

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
    const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID;
    const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI;

    if (!appId || !redirectUri) {
      console.error('Missing Deriv configuration');
      return;
    }

    // Construct OAuth URL with response_type=code
    const oauthUrl = `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&l=EN&redirect_uri=${redirectUri}&response_type=code&scope=read+trade`;

    window.location.href = oauthUrl;
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center p-4 overflow-hidden">
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
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-xl mb-6 shadow-[0_0_40px_-10px_rgba(0,245,255,0.3)]"
            whileHover={{ scale: 1.05 }}
          >
            <Zap className="w-8 h-8 text-[#00f5ff]" />
          </motion.div>

          <h1 className="text-6xl md:text-7xl font-bold tracking-tight text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">
            DerivNexus
          </h1>
          <p className="text-lg md:text-xl text-gray-400 uppercase tracking-[0.2em] font-light">
            Algorithmic Trading Terminal
          </p>
        </motion.div>

        {/* Action Section */}
        <motion.div variants={itemVariants} className="w-full max-w-sm space-y-8">
          <button
            onClick={handleLogin}
            className="group relative w-full flex items-center justify-center gap-3 bg-white text-black px-8 py-5 rounded-full font-semibold text-lg hover:bg-[#00f5ff] hover:text-black transition-all duration-300 hover:shadow-[0_0_40px_-5px_rgba(0,245,255,0.4)]"
          >
            <span>Continue with Deriv</span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </button>

          <div className="flex justify-center gap-8 text-sm text-gray-500 font-medium">
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
        className="absolute bottom-8 text-xs text-gray-600 tracking-wider"
      >
        POWERED BY DERIV API
      </motion.div>
    </div>
  );
}
