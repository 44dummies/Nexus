'use client';

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerspectiveCamera } from '@react-three/drei';
import ParticleWave from './ParticleWave';

export function Scene3D() {
    return (
        <div className="fixed inset-0 -z-10 bg-[#0a0a0f]">
            <Canvas
                className="w-full h-full"
                dpr={[1, 2]}
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
                    <pointLight position={[10, 10, 10]} intensity={1} color="#00f5ff" />
                    <pointLight position={[-10, -10, -10]} intensity={0.5} color="#a855f7" />

                    {/* Full Screen Particle Wave */}
                    <ParticleWave />
                </Suspense>
            </Canvas>
        </div>
    );
}
