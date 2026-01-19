'use client';

import { useRef, useMemo, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

const PARTICLE_COUNT = 6000;

export default function ParticleWave() {
    const meshRef = useRef<THREE.Points>(null);
    const { camera, viewport } = useThree();

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

            // Add some random fuzz to make it a volumetric cloud/blob, not just a shell
            const fuzz = 0.8 + Math.random() * 0.4; // 0.8 to 1.2

            const finalX = x * fuzz;
            const finalY = y * fuzz;
            const finalZ = z * fuzz;

            positions[i * 3] = finalX;
            positions[i * 3 + 1] = finalY;
            positions[i * 3 + 2] = finalZ;

            originalPositions[i * 3] = finalX;
            originalPositions[i * 3 + 1] = finalY;
            originalPositions[i * 3 + 2] = finalZ;
        }

        return { positions, originalPositions };
    }, []);

    // Colors
    const colors = useMemo(() => {
        const colors = new Float32Array(PARTICLE_COUNT * 3);
        const color1 = new THREE.Color('#00f5ff'); // Cyan
        const color2 = new THREE.Color('#a855f7'); // Purple

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const t = Math.random();
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

    useFrame((state) => {
        if (!meshRef.current) return;
        const time = state.clock.getElapsedTime();
        const positionAttribute = geometry.getAttribute('position');
        const array = positionAttribute.array as Float32Array;

        // Convert mouse NDC to world coordinates at Z=0
        // Simple unproject is complex with perspective camera depth, 
        // but for Z=0 plane and fixed camera, we can convert roughly or use logic below.

        // Better approach: Vector3 unproject
        const vector = new THREE.Vector3(mouseNDC.current.x, mouseNDC.current.y, 0.5);
        vector.unproject(camera);
        const dir = vector.sub(camera.position).normalize();
        const distance = -camera.position.z / dir.z;
        const mouseWorld = camera.position.clone().add(dir.multiplyScalar(distance));

        // Apply very slow rotation to the entire blob
        const rotationSpeed = 0.1;
        const cosR = Math.cos(rotationSpeed * time * 0.1);
        const sinR = Math.sin(rotationSpeed * time * 0.1);

        // Update Particles
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const i3 = i * 3;
            let ox = originalPositions[i3];
            let oy = originalPositions[i3 + 1];
            let oz = originalPositions[i3 + 2];

            // Apply rotation
            const rx = ox * cosR - oz * sinR;
            const rz = ox * sinR + oz * cosR;
            ox = rx;
            oz = rz;

            // Mouse Distance
            const dx = ox - mouseWorld.x;
            const dy = oy - mouseWorld.y;
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
