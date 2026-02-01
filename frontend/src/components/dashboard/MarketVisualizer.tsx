'use client';

import React, { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useTheme } from 'next-themes';

interface ThemePalette {
    up: string;
    down: string;
    neutral: string;
    base: string;
}

interface MarketParticlesProps {
    tickDirection: 'up' | 'down' | 'neutral';
    tickSpeed: number; // 0-1 normalized speed based on tick change magnitude
    palette: ThemePalette;
}

const PARTICLE_COUNT = 1200; // Reduced for smoother rendering
const DEFAULT_PALETTE: ThemePalette = {
    up: '#2da44e',
    down: '#cf222e',
    neutral: '#8b949e',
    base: '#94a3b8',
};

function MarketParticles({ tickDirection, tickSpeed, palette }: MarketParticlesProps) {
    const meshRef = useRef<THREE.Points>(null);
    const velocitiesRef = useRef<Float32Array>(new Float32Array(PARTICLE_COUNT * 3));

    // Generate particles (Deterministic)
    const { positions, colors } = useMemo(() => {
        const positions = new Float32Array(PARTICLE_COUNT * 3);
        const colors = new Float32Array(PARTICLE_COUNT * 3);
        // Velocities are in ref, initialized with zeros by default constructor

        // Deterministic init (basically reset)
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            // Init with zeros or grid, waiting for client hydration to randomized
            // actually zeros is fine
        }

        return { positions, colors };
    }, []);

    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geo;
    }, [positions, colors]);

    // Apply Randomness on Client
    useEffect(() => {
        const posAttr = geometry.getAttribute('position');
        const colAttr = geometry.getAttribute('color');
        const posArray = posAttr.array as Float32Array;
        const colArray = colAttr.array as Float32Array;
        const velocities = velocitiesRef.current;
        const baseColor = new THREE.Color(palette.base || DEFAULT_PALETTE.base);

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            // Spread across a wide area
            posArray[i3] = (Math.random() - 0.5) * 50;
            posArray[i3 + 1] = (Math.random() - 0.5) * 30;
            posArray[i3 + 2] = (Math.random() - 0.5) * 20;

            // Random velocities
            velocities[i3] = (Math.random() - 0.5) * 0.02;
            velocities[i3 + 1] = (Math.random() - 0.5) * 0.02;
            velocities[i3 + 2] = (Math.random() - 0.5) * 0.02;

            // Initial neutral color
            colArray[i3] = baseColor.r;
            colArray[i3 + 1] = baseColor.g;
            colArray[i3 + 2] = baseColor.b;
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
    }, [geometry, palette]);

    // Target colors based on direction
    const targetColor = useMemo(() => {
        if (tickDirection === 'up') return new THREE.Color(palette.up);
        if (tickDirection === 'down') return new THREE.Color(palette.down);
        return new THREE.Color(palette.neutral);
    }, [tickDirection, palette]);

    useFrame((state, delta) => {
        if (!meshRef.current) return;

        const positionAttribute = geometry.getAttribute('position');
        const colorAttribute = geometry.getAttribute('color');
        const posArray = positionAttribute.array as Float32Array;
        const colArray = colorAttribute.array as Float32Array;
        const velocities = velocitiesRef.current;

        // Speed multiplier based on tick activity
        const speedMultiplier = 0.5 + tickSpeed * 2; // Range 0.5 to 2.5

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;

            // Move particles
            posArray[i3] += velocities[i3] * speedMultiplier;
            posArray[i3 + 1] += velocities[i3 + 1] * speedMultiplier;
            posArray[i3 + 2] += velocities[i3 + 2] * speedMultiplier;

            // Wrap around if out of bounds
            if (posArray[i3] > 25) posArray[i3] = -25;
            if (posArray[i3] < -25) posArray[i3] = 25;
            if (posArray[i3 + 1] > 15) posArray[i3 + 1] = -15;
            if (posArray[i3 + 1] < -15) posArray[i3 + 1] = 15;

            // Lerp colors towards target
            const lerpFactor = 0.02;
            colArray[i3] += (targetColor.r - colArray[i3]) * lerpFactor;
            colArray[i3 + 1] += (targetColor.g - colArray[i3 + 1]) * lerpFactor;
            colArray[i3 + 2] += (targetColor.b - colArray[i3 + 2]) * lerpFactor;
        }

        positionAttribute.needsUpdate = true;
        colorAttribute.needsUpdate = true;
    });

    return (
        <points ref={meshRef} geometry={geometry}>
            <pointsMaterial
                size={0.06}
                vertexColors
                transparent
                opacity={0.45}
                blending={THREE.NormalBlending}
                sizeAttenuation
                depthWrite={false}
            />
        </points>
    );
}

interface MarketVisualizerProps {
    lastTick?: number;
    prevTick?: number;
}

function MarketVisualizer({ lastTick = 0, prevTick = 0 }: MarketVisualizerProps) {
    const { theme } = useTheme();
    const [enabled, setEnabled] = useState(true);
    const [dpr, setDpr] = useState<[number, number]>([1, 1.5]);
    const [palette, setPalette] = useState<ThemePalette>(DEFAULT_PALETTE);
    const [contextLost, setContextLost] = useState(false);
    const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const isSmall = window.innerWidth < 900;
        const deviceMemory = 'deviceMemory' in navigator ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
        const cpuCores = navigator.hardwareConcurrency;
        const lowPower = (deviceMemory && deviceMemory <= 4) || (cpuCores && cpuCores <= 4);
        if (media.matches || isSmall || lowPower) {
            setEnabled(false);
        }
        if (window.devicePixelRatio && window.devicePixelRatio > 2) {
            setDpr([1, 1.25]);
        }
    }, []);

    useEffect(() => {
        if (!canvasEl) return;
        const handleContextLost = (event: Event) => {
            event.preventDefault();
            setContextLost(true);
        };

        canvasEl.addEventListener('webglcontextlost', handleContextLost, { passive: false });
        return () => {
            canvasEl.removeEventListener('webglcontextlost', handleContextLost);
        };
    }, [canvasEl]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const styles = getComputedStyle(document.documentElement);
        const readVar = (name: string, fallback: string) => {
            const value = styles.getPropertyValue(name).trim();
            return value || fallback;
        };
        setPalette({
            up: readVar('--chart-2', DEFAULT_PALETTE.up),
            down: readVar('--chart-4', DEFAULT_PALETTE.down),
            neutral: readVar('--muted-foreground', DEFAULT_PALETTE.neutral),
            base: readVar('--foreground', DEFAULT_PALETTE.base),
        });
    }, [theme]);

    if (!enabled || contextLost) {
        return null;
    }
    // Determine direction and speed
    const tickDirection: 'up' | 'down' | 'neutral' =
        lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';

    // Normalize speed based on price change (capped)
    const tickSpeed = Math.min(Math.abs(lastTick - prevTick) / 0.5, 1); // Assumes ~0.5 max change

    return (
        <div className="fixed inset-0 -z-10 pointer-events-none">
            <Canvas
                dpr={dpr}
                gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
                camera={{ position: [0, 0, 20], fov: 60 }}
                onCreated={({ gl }) => setCanvasEl(gl.domElement)}
            >
                <MarketParticles tickDirection={tickDirection} tickSpeed={tickSpeed} palette={palette} />
                <ambientLight intensity={0.2} />
            </Canvas>
        </div>
    );
}

const MarketVisualizerMemo = React.memo(MarketVisualizer);
export default MarketVisualizerMemo;
