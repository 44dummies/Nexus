'use client';

import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import ParticleWave from './ParticleWave';

export function Scene3D() {
    const [{ enabled, dpr }] = useState(() => {
        if (typeof window === 'undefined') {
            return { enabled: false, dpr: [1, 1.5] as [number, number] };
        }
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const isSmall = window.innerWidth < 900;
        const deviceMemory = 'deviceMemory' in navigator ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
        const cpuCores = navigator.hardwareConcurrency;
        const lowPower = (deviceMemory && deviceMemory <= 4) || (cpuCores && cpuCores <= 4);
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
        const canRender = !media.matches && !isSmall && !lowPower && !!gl;
        const nextDpr: [number, number] = window.devicePixelRatio && window.devicePixelRatio > 2 ? [1, 1.25] : [1, 1.5];
        return { enabled: canRender, dpr: nextDpr };
    });
    const [contextLost, setContextLost] = useState(false);
    const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);

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

    if (!enabled || contextLost) {
        return <div className="fixed inset-0 -z-10 bg-gradient-to-br from-background to-muted" />;
    }

    return (
        <div className="fixed inset-0 -z-10 bg-[#0a0a0f]">
            <Canvas
                className="w-full h-full"
                dpr={dpr}
                gl={{
                    antialias: false,
                    alpha: true,
                    powerPreference: 'low-power'
                }}
                onCreated={({ gl }) => setCanvasEl(gl.domElement)}
            >
                <Suspense fallback={null}>
                    {/* Camera positioned to look straight at the wall of particles */}
                    <PerspectiveCamera
                        makeDefault
                        position={[0, 0, 30]}
                        fov={60}
                        near={0.1}
                        far={1000}
                    />

                    {/* Lighting */}
                    <ambientLight intensity={0.5} />
                    <pointLight position={[10, 10, 10]} intensity={1} color="#2f81f7" />
                    <pointLight position={[-10, -10, -10]} intensity={0.5} color="#0ea5e9" />

                    {/* Full Screen Particle Wave */}
                    <ParticleWave />
                </Suspense>
            </Canvas>
        </div>
    );
}
