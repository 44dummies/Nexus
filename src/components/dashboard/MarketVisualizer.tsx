'use client';

import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface MarketParticlesProps {
    tickDirection: 'up' | 'down' | 'neutral';
    tickSpeed: number; // 0-1 normalized speed based on tick change magnitude
}

const PARTICLE_COUNT = 3000;

function MarketParticles({ tickDirection, tickSpeed }: MarketParticlesProps) {
    const meshRef = useRef<THREE.Points>(null);
    const velocitiesRef = useRef<Float32Array>(new Float32Array(PARTICLE_COUNT * 3));

    // Generate particles
    const { positions, colors } = useMemo(() => {
        const positions = new Float32Array(PARTICLE_COUNT * 3);
        const colors = new Float32Array(PARTICLE_COUNT * 3);
        const velocities = velocitiesRef.current;

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            // Spread across a wide area
            positions[i3] = (Math.random() - 0.5) * 50;
            positions[i3 + 1] = (Math.random() - 0.5) * 30;
            positions[i3 + 2] = (Math.random() - 0.5) * 20;

            // Random velocities
            velocities[i3] = (Math.random() - 0.5) * 0.02;
            velocities[i3 + 1] = (Math.random() - 0.5) * 0.02;
            velocities[i3 + 2] = (Math.random() - 0.5) * 0.02;

            // Initial neutral color (gray-blue)
            colors[i3] = 0.3;
            colors[i3 + 1] = 0.4;
            colors[i3 + 2] = 0.5;
        }

        return { positions, colors };
    }, []);

    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geo;
    }, [positions, colors]);

    // Target colors based on direction
    const targetColor = useMemo(() => {
        if (tickDirection === 'up') return new THREE.Color('#00ff88'); // Green
        if (tickDirection === 'down') return new THREE.Color('#ff4444'); // Red
        return new THREE.Color('#6b7280'); // Gray
    }, [tickDirection]);

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
                size={0.08}
                vertexColors
                transparent
                opacity={0.6}
                blending={THREE.AdditiveBlending}
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

export default function MarketVisualizer({ lastTick = 0, prevTick = 0 }: MarketVisualizerProps) {
    // Determine direction and speed
    const tickDirection: 'up' | 'down' | 'neutral' =
        lastTick > prevTick ? 'up' : lastTick < prevTick ? 'down' : 'neutral';

    // Normalize speed based on price change (capped)
    const tickSpeed = Math.min(Math.abs(lastTick - prevTick) / 0.5, 1); // Assumes ~0.5 max change

    return (
        <div className="fixed inset-0 -z-5 pointer-events-none">
            <Canvas
                gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
                camera={{ position: [0, 0, 20], fov: 60 }}
            >
                <MarketParticles tickDirection={tickDirection} tickSpeed={tickSpeed} />
                <ambientLight intensity={0.2} />
            </Canvas>
        </div>
    );
}
