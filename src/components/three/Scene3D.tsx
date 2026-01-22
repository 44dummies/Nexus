'use client';

import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import ParticleWave from './ParticleWave';

export function Scene3D() {
    const [enabled, setEnabled] = useState(true);
    const [dpr, setDpr] = useState<[number, number]>([1, 2]);

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const isSmall = window.innerWidth < 900;
        if (media.matches || isSmall) {
            setEnabled(false);
        }
        if (window.devicePixelRatio && window.devicePixelRatio > 2) {
            setDpr([1, 1.5]);
        }
    }, []);

    if (!enabled) {
        return <div className="fixed inset-0 -z-10 bg-gradient-to-br from-background to-muted" />;
    }

    return (
        <div className="fixed inset-0 -z-10 bg-[#0a0a0f]">
            <Canvas
                className="w-full h-full"
                dpr={dpr}
                gl={{
                    antialias: true,
                    alpha: true,
                    powerPreference: 'high-performance'
                }}
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
