'use client';

import { useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { motion, useReducedMotion, useInView } from 'framer-motion';
import {
  ArrowRight,
  Zap,
  Shield,
  BarChart3,
  TrendingUp,
  Clock,
  Lock,
  ChevronDown,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { LogoMark } from '@/components/brand/LogoMark';
import { toast } from 'sonner';

const LiquidEther = dynamic(
  () => import('@/components/backgrounds/LiquidEther'),
  { ssr: false }
);

/* ─── animation helpers ─── */
const ease: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

function useFade(delay = 0) {
  const rm = useReducedMotion();
  return {
    initial: { opacity: rm ? 1 : 0, y: rm ? 0 : 24 } as const,
    animate: { opacity: 1, y: 0 } as const,
    transition: { duration: rm ? 0 : 0.7, delay: rm ? 0 : delay, ease },
  };
}

/* ─── feature data ─── */
const features = [
  {
    icon: TrendingUp,
    title: 'Algorithmic Execution',
    desc: 'Deploy automated strategies on Deriv markets with sub-second execution. Configure entry logic, stake sizing, and duration — the engine handles the rest.',
  },
  {
    icon: Shield,
    title: 'Built-in Risk Controls',
    desc: 'Per-session loss limits, consecutive-loss circuit breakers, and maximum drawdown gates. Every trade passes through a pre-trade risk gate before execution.',
  },
  {
    icon: BarChart3,
    title: 'Live Performance Tracking',
    desc: 'Real-time PnL streaming, trade-by-trade history, and performance analytics. See exactly what your bot is doing and why, as it happens.',
  },
];

const stats = [
  { value: '<50ms', label: 'Execution latency' },
  { value: '24/7', label: 'Market monitoring' },
  { value: 'OAuth 2.0', label: 'Secure authentication' },
  { value: 'Real-time', label: 'WebSocket streaming' },
];

/* ─── main page ─── */
export default function LandingPage() {
  const shouldReduceMotion = useReducedMotion();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const featuresRef = useRef<HTMLDivElement>(null);
  const featuresInView = useInView(featuresRef, { once: true, margin: '-80px' });
  const statsRef = useRef<HTMLDivElement>(null);
  const statsInView = useInView(statsRef, { once: true, margin: '-60px' });

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

  const scrollToFeatures = () => {
    featuresRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="midnight">
      <div className="relative min-h-screen bg-[#08090d] text-[#c9d1d9] overflow-x-hidden">
        {/* ── Background ── */}
        <div className="fixed inset-0 z-0" style={{ width: '100%', height: '100%' }}>
          <LiquidEther
            colors={['#5227FF', '#FF9FFC', '#B19EEF']}
            mouseForce={20}
            cursorSize={100}
            isViscous
            viscous={30}
            iterationsViscous={32}
            iterationsPoisson={32}
            resolution={0.5}
            isBounce={false}
            autoDemo
            autoSpeed={0.5}
            autoIntensity={2.2}
            takeoverDuration={0.25}
            autoResumeDelay={3000}
            autoRampDuration={0.6}
            className="pointer-events-auto"
          />
        </div>

        {/* Dark overlay gradient so text reads clearly */}
        <div
          className="fixed inset-0 z-[1] pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(8,9,13,0.55) 0%, rgba(8,9,13,0.35) 30%, rgba(8,9,13,0.45) 70%, rgba(8,9,13,0.85) 100%)',
          }}
        />

        {/* ── Nav ── */}
        <motion.nav
          {...useFade(0)}
          className="relative z-10 flex items-center justify-between px-6 md:px-12 lg:px-20 py-5"
        >
          <div className="flex items-center gap-3">
            <LogoMark size={32} priority />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              DerivNexus
            </span>
          </div>
          <button
            onClick={handleLogin}
            disabled={isSubmitting}
            className="text-sm font-medium px-5 py-2 rounded-lg bg-white/[0.08] border border-white/[0.1] text-white/90 hover:bg-white/[0.14] hover:text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Connecting…' : 'Sign in'}
          </button>
        </motion.nav>

        {/* ── Hero ── */}
        <section className="relative z-10 flex flex-col items-center text-center px-6 pt-16 pb-24 md:pt-24 md:pb-32 lg:pt-32 lg:pb-40">
          <motion.div {...useFade(0.15)} className="mb-6">
            <span className="inline-flex items-center gap-2 text-xs font-medium tracking-widest uppercase text-[#B19EEF] border border-[#B19EEF]/20 rounded-full px-4 py-1.5 bg-[#B19EEF]/[0.06]">
              <Zap className="w-3 h-3" />
              Algorithmic Trading Terminal
            </span>
          </motion.div>

          <motion.h1
            {...useFade(0.3)}
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tight text-white leading-[1.1] max-w-4xl"
          >
            Trade smarter.{' '}
            <span className="bg-gradient-to-r from-[#A78BFA] via-[#C084FC] to-[#F0ABFC] bg-clip-text text-transparent">
              Not harder.
            </span>
          </motion.h1>

          <motion.p
            {...useFade(0.45)}
            className="mt-6 text-base md:text-lg text-[#8b949e] max-w-2xl leading-relaxed"
          >
            Deploy automated trading strategies on Deriv synthetic markets.
            Built-in risk management, real-time monitoring, and full control
            over every parameter — from entry logic to stop conditions.
          </motion.p>

          <motion.div {...useFade(0.6)} className="mt-10 flex flex-col sm:flex-row items-center gap-4">
            <button
              onClick={handleLogin}
              disabled={isSubmitting}
              className="group flex items-center gap-2.5 bg-white text-[#0d1117] font-semibold text-sm px-7 py-3.5 rounded-xl hover:bg-white/90 transition-all duration-200 shadow-[0_0_20px_rgba(255,255,255,0.08)] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span>{isSubmitting ? 'Connecting…' : 'Get started with Deriv'}</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <button
              onClick={scrollToFeatures}
              className="flex items-center gap-2 text-sm text-[#8b949e] hover:text-white/80 transition-colors duration-200"
            >
              See how it works
              <ChevronDown className="w-4 h-4" />
            </button>
          </motion.div>

          <motion.div
            {...useFade(0.75)}
            className="mt-8 flex items-center gap-6 text-xs text-[#6e7681]"
          >
            <span className="flex items-center gap-1.5">
              <Lock className="w-3 h-3" /> OAuth 2.0
            </span>
            <span className="w-px h-3 bg-[#30363d]" />
            <span className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Real-time data
            </span>
            <span className="w-px h-3 bg-[#30363d]" />
            <span>No payment required</span>
          </motion.div>
        </section>

        {/* ── Features ── */}
        <section
          ref={featuresRef}
          className="relative z-10 px-6 md:px-12 lg:px-20 pb-24 md:pb-32"
        >
          <div className="max-w-6xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={featuresInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: shouldReduceMotion ? 0 : 0.6, ease }}
              className="text-center mb-16"
            >
              <h2 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">
                Everything you need to automate
              </h2>
              <p className="mt-3 text-[#8b949e] text-sm md:text-base max-w-lg mx-auto">
                A complete system — not just a signal bot. From strategy execution to
                risk management to live analytics.
              </p>
            </motion.div>

            <div className="grid md:grid-cols-3 gap-5 lg:gap-6">
              {features.map((f, i) => (
                <motion.div
                  key={f.title}
                  initial={{ opacity: 0, y: 28 }}
                  animate={featuresInView ? { opacity: 1, y: 0 } : {}}
                  transition={{
                    duration: shouldReduceMotion ? 0 : 0.6,
                    delay: shouldReduceMotion ? 0 : 0.15 * i,
                    ease,
                  }}
                  className="group rounded-2xl border border-white/[0.06] bg-white/[0.02] p-7 lg:p-8 hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-300"
                >
                  <div className="w-10 h-10 rounded-xl bg-[#B19EEF]/10 flex items-center justify-center mb-5">
                    <f.icon className="w-5 h-5 text-[#B19EEF]" />
                  </div>
                  <h3 className="text-[15px] font-semibold text-white mb-2.5 tracking-tight">
                    {f.title}
                  </h3>
                  <p className="text-sm text-[#8b949e] leading-relaxed">
                    {f.desc}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Stats ── */}
        <section ref={statsRef} className="relative z-10 px-6 md:px-12 lg:px-20 pb-24 md:pb-32">
          <div className="max-w-4xl mx-auto">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 md:p-10">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                {stats.map((s, i) => (
                  <motion.div
                    key={s.label}
                    initial={{ opacity: 0, y: 16 }}
                    animate={statsInView ? { opacity: 1, y: 0 } : {}}
                    transition={{
                      duration: shouldReduceMotion ? 0 : 0.5,
                      delay: shouldReduceMotion ? 0 : 0.1 * i,
                      ease,
                    }}
                    className="text-center"
                  >
                    <div className="text-xl md:text-2xl font-semibold text-white tracking-tight">
                      {s.value}
                    </div>
                    <div className="mt-1 text-xs text-[#6e7681] tracking-wide">
                      {s.label}
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="relative z-10 px-6 md:px-12 lg:px-20 pb-24 md:pb-32">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.7, ease }}
            className="max-w-2xl mx-auto text-center"
          >
            <h2 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">
              Ready to start?
            </h2>
            <p className="mt-3 text-[#8b949e] text-sm md:text-base">
              Connect your Deriv account and deploy your first automated strategy
              in minutes. No credit card, no commitment.
            </p>
            <button
              onClick={handleLogin}
              disabled={isSubmitting}
              className="mt-8 group inline-flex items-center gap-2.5 bg-white text-[#0d1117] font-semibold text-sm px-7 py-3.5 rounded-xl hover:bg-white/90 transition-all duration-200 shadow-[0_0_20px_rgba(255,255,255,0.08)] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <span>{isSubmitting ? 'Connecting…' : 'Get started — it\'s free'}</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </motion.div>
        </section>

        {/* ── Footer ── */}
        <footer className="relative z-10 border-t border-white/[0.06] px-6 md:px-12 lg:px-20 py-8">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2.5 text-[#6e7681] text-xs">
              <LogoMark size={20} />
              <span>DerivNexus</span>
              <span className="text-[#30363d]">·</span>
              <span>Powered by Deriv API</span>
            </div>
            <div className="text-xs text-[#6e7681]">
              Trading involves risk. Automated strategies can incur losses.
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
