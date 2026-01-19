'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export function GridBackground() {
    const meshRef = useRef<THREE.Mesh>(null);
    const materialRef = useRef<THREE.ShaderMaterial>(null);

    // Vertex shader - creates the grid
    const vertexShader = `
    varying vec2 vUv;
    varying vec3 vPosition;
    
    void main() {
      vUv = uv;
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

    // Fragment shader - animates colors and grid lines
    const fragmentShader = `
    uniform float uTime;
    uniform vec2 uMouse;
    varying vec2 vUv;
    varying vec3 vPosition;
    
    void main() {
      // Grid lines
      vec2 grid = abs(fract(vUv * 20.0 - 0.5) - 0.5) / fwidth(vUv * 20.0);
      float line = min(grid.x, grid.y);
      
      // Animated gradient background
      vec3 color1 = vec3(0.02, 0.02, 0.06); // Deep blue-black
      vec3 color2 = vec3(0.0, 0.6, 0.8); // Cyan
      vec3 color3 = vec3(0.4, 0.2, 0.8); // Purple
      
      // Create flowing gradient
      float mixValue = sin(vUv.x * 2.0 + uTime * 0.3) * 0.5 + 0.5;
      vec3 bgColor = mix(color1, color2, mixValue * 0.3);
      bgColor = mix(bgColor, color3, vUv.y * 0.2);
      
      // Mouse interaction glow
      float dist = distance(vUv, uMouse);
      float glow = smoothstep(0.5, 0.0, dist) * 0.3;
      bgColor += vec3(0.0, 0.4, 0.6) * glow;
      
      // Grid line color with fade
      vec3 gridColor = vec3(0.0, 0.8, 1.0) * 0.4;
      float gridStrength = 1.0 - min(line, 1.0);
      gridStrength *= 0.3; // Subtle grid
      
      // Combine
      vec3 finalColor = mix(bgColor, gridColor, gridStrength);
      
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

    useFrame((state) => {
        if (materialRef.current) {
            materialRef.current.uniforms.uTime.value = state.clock.getElapsedTime();
            // Map pointer to UV coordinates (0-1)
            materialRef.current.uniforms.uMouse.value.set(
                (state.pointer.x + 1) / 2,
                (state.pointer.y + 1) / 2
            );
        }
    });

    return (
        <mesh ref={meshRef} rotation={[-Math.PI / 2.5, 0, 0]} position={[0, -5, -10]}>
            <planeGeometry args={[100, 100, 1, 1]} />
            <shaderMaterial
                ref={materialRef}
                vertexShader={vertexShader}
                fragmentShader={fragmentShader}
                uniforms={{
                    uTime: { value: 0 },
                    uMouse: { value: new THREE.Vector2(0.5, 0.5) }
                }}
                side={THREE.DoubleSide}
            />
        </mesh>
    );
}
