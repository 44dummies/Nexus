'use client';

import { useRef, useMemo, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const PARTICLE_COUNT = 3000; // Reduced from 6000 for better performance

// Pre-allocated objects to avoid per-frame allocations
const tempVector = new THREE.Vector3();
const tempDirection = new THREE.Vector3();
const mouseWorldPos = new THREE.Vector3();

export default function ParticleWave() {
    const meshRef = useRef<THREE.Points>(null);
    const { camera } = useThree();
    // Track mouse in Normalized Device Coordinates (-1 to 1) using native listeners
    // This ensures tracking works regardless of R3F overlay/canvas issues
    const mouseNDC = useRef({ x: 0, y: 0 });

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            mouseNDC.current.x = (e.clientX / window.innerWidth) * 2 - 1;
            mouseNDC.current.y = -(e.clientY / window.innerHeight) * 2 + 1;
        };
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    // Generate particles arranged in a spherical BLOB shape
    const { positions, originalPositions } = useMemo(() => {
        const positions = new Float32Array(PARTICLE_COUNT * 3);
        const originalPositions = new Float32Array(PARTICLE_COUNT * 3);

        // Radius of the main blob
        const radius = 12;

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            // Spherical distribution using Golden Spiral (Fibonacci Sphere)
            // This gives a nice even distribution on a sphere surface
            const phi = Math.acos(1 - 2 * (i + 0.5) / PARTICLE_COUNT);
            const theta = Math.PI * (1 + Math.sqrt(5)) * i;

            // Convert spherical to cartesian
            const x = radius * Math.sin(phi) * Math.cos(theta);
            const y = radius * Math.sin(phi) * Math.sin(theta);
            const z = radius * Math.cos(phi);

            // Deterministic initial state (perfect sphere)
            positions[i * 3] = x;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = z;

            originalPositions[i * 3] = x;
            originalPositions[i * 3 + 1] = y;
            originalPositions[i * 3 + 2] = z;
        }

        return { positions, originalPositions };
    }, []);

    // Colors
    const colors = useMemo(() => {
        const colors = new Float32Array(PARTICLE_COUNT * 3);
        const color1 = new THREE.Color('#2f81f7');
        const color2 = new THREE.Color('#0ea5e9');

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            // Deterministic initial colors (gradient based on index)
            const t = i / PARTICLE_COUNT;
            const c = color1.clone().lerp(color2, t);
            colors[i * 3] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }
        return colors;
    }, []);

    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geo;
    }, [positions, colors]);

    // Apply random fuzz and colors on client mount
    useEffect(() => {
        const posAttr = geometry.getAttribute('position');
        const colAttr = geometry.getAttribute('color');
        const posArray = posAttr.array as Float32Array;
        const colArray = colAttr.array as Float32Array;
        const color1 = new THREE.Color('#2f81f7');
        const color2 = new THREE.Color('#0ea5e9');

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            // Add random fuzz
            const fuzz = 0.8 + Math.random() * 0.4;

            // We need original base position for fuzzing correctly, but we can just fuzz current position 
            // since current is deterministic sphere.
            // BUT originalPositions needs to be updated too for animation!
            // We can read from originalPositions (which is same ref as positions initially? No, separate arrays).
            // We should update originalPositions too.
            // Wait, originalPositions is not in geometry attribute, it's a separate array returned from useMemo.
            // We need access to it.

            const i3 = i * 3;
            const x = originalPositions[i3];
            const y = originalPositions[i3 + 1];
            const z = originalPositions[i3 + 2];

            const finalX = x * fuzz;
            const finalY = y * fuzz;
            const finalZ = z * fuzz;

            // Update both
            posArray[i3] = finalX;
            posArray[i3 + 1] = finalY;
            posArray[i3 + 2] = finalZ;

            originalPositions[i3] = finalX;
            originalPositions[i3 + 1] = finalY;
            originalPositions[i3 + 2] = finalZ;

            // Random color mix
            const t = Math.random();
            const c = color1.clone().lerp(color2, t);
            colArray[i3] = c.r;
            colArray[i3 + 1] = c.g;
            colArray[i3 + 2] = c.b;
        }

        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [geometry]); // originalPositions is stable from useMemo

    useFrame((state) => {
        if (!meshRef.current) return;
        const time = state.clock.getElapsedTime();
        const positionAttribute = geometry.getAttribute('position');
        const array = positionAttribute.array as Float32Array;

        // Convert mouse NDC to world coordinates at Z=0
        tempVector.set(mouseNDC.current.x, mouseNDC.current.y, 0.5);
        tempVector.unproject(camera);
        tempDirection.copy(tempVector).sub(camera.position).normalize();
        const distance = -camera.position.z / tempDirection.z;
        mouseWorldPos.copy(camera.position).add(tempDirection.multiplyScalar(distance));

        // Apply very slow rotation to the entire blob
        const rotationSpeed = 0.1;
        const cosR = Math.cos(rotationSpeed * time * 0.1);
        const sinR = Math.sin(rotationSpeed * time * 0.1);

        // Update Particles
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            let ox = originalPositions[i3];
            const oy = originalPositions[i3 + 1]; // FIX: const
            let oz = originalPositions[i3 + 2];

            // Apply rotation
            const rx = ox * cosR - oz * sinR;
            const rz = ox * sinR + oz * cosR;
            ox = rx;
            oz = rz;

            // Mouse Distance
            const dx = ox - mouseWorldPos.x;
            const dy = oy - mouseWorldPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Interaction - Push away/ripple
            let displacement = 0;
            const radius = 10;

            if (dist < radius) {
                const intensity = (1 - dist / radius);
                // "Magnetic" effect - slight bulge towards camera + ripple
                displacement = Math.sin(dist * 2 - time * 4) * intensity * 3;
            }

            array[i3] = ox;     // Update rotated X
            array[i3 + 1] = oy; // Update Y
            array[i3 + 2] = oz + displacement; // Update Z with ripple
        }

        positionAttribute.needsUpdate = true;
    });

    return (
        <points ref={meshRef} geometry={geometry}>
            <pointsMaterial
                size={0.15}
                vertexColors
                transparent
                opacity={0.8}
                blending={THREE.AdditiveBlending}
                sizeAttenuation
                depthWrite={false}
            />
        </points>
    );
}
