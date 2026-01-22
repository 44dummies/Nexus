'use client';

import { useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Text, useCursor, PerspectiveCamera, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { motion } from 'framer-motion';

const StrategyShape = ({ position, label, isSelected, onClick }: { position: [number, number, number], label: string, isSelected: boolean, onClick: () => void }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const [hovered, setHover] = useState(false);

    useCursor(hovered);

    useFrame((state, delta) => {
        if (meshRef.current) {
            // Basic rotation
            meshRef.current.rotation.x += delta * 0.2;
            meshRef.current.rotation.y += delta * 0.3;

            // Pulse effect when selected
            if (isSelected) {
                const scale = 1 + Math.sin(state.clock.elapsedTime * 3) * 0.05;
                meshRef.current.scale.set(scale, scale, scale);
            } else {
                meshRef.current.scale.set(1, 1, 1);
            }
        }
    });

    return (
        <group position={position}>
            <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
                <mesh
                    ref={meshRef}
                    onClick={onClick}
                    onPointerOver={() => setHover(true)}
                    onPointerOut={() => setHover(false)}
                >
                    <icosahedronGeometry args={[1.2, 0]} />
                    <meshStandardMaterial
                        color={isSelected ? "#2f81f7" : (hovered ? "#0ea5e9" : "#6b7280")}
                        roughness={0.1}
                        metalness={0.8}
                        transparent
                        opacity={0.8}
                        wireframe={!isSelected}
                    />
                </mesh>
                <Text
                    position={[0, -1.8, 0]}
                    fontSize={0.3}
                    color="white"
                    anchorX="center"
                    anchorY="middle"
                >
                    {label}
                </Text>
            </Float>
        </group>
    );
};

export default function StrategySelector() {
    // In a real app, this would come from the store. 
    // For now, local state or mocked structure.
    // We'll update the store if we have a setStrategy action, otherwise just UI.
    const [activeStrategy, setActiveStrategy] = useState('RSI');

    return (
        <div className="w-full h-[300px] relative glass-panel rounded-2xl overflow-hidden">
            <div className="absolute top-4 left-6 z-10 pointer-events-none">
                <h3 className="text-muted-foreground font-mono text-sm uppercase tracking-widest">Strategy Matrix</h3>
                <h2 className="text-2xl font-bold text-accent mt-1">{activeStrategy}</h2>
            </div>

            <Canvas gl={{ antialias: true, alpha: true }}>
                <PerspectiveCamera makeDefault position={[0, 0, 8]} />
                <ambientLight intensity={0.5} />
                <pointLight position={[10, 10, 10]} intensity={1} color="#2f81f7" />
                <pointLight position={[-10, -5, -10]} intensity={0.5} color="#0ea5e9" />

                {/* Strategy Nodes */}
                <StrategyShape
                    position={[-3, 0, 0]}
                    label="RSI DIVERGENCE"
                    isSelected={activeStrategy === 'RSI'}
                    onClick={() => setActiveStrategy('RSI')}
                />
                <StrategyShape
                    position={[0, 0, 0]}
                    label="BOLLINGER"
                    isSelected={activeStrategy === 'BOLLINGER'}
                    onClick={() => setActiveStrategy('BOLLINGER')}
                />
                <StrategyShape
                    position={[3, 0, 0]}
                    label="MACD CROSS"
                    isSelected={activeStrategy === 'MACD'}
                    onClick={() => setActiveStrategy('MACD')}
                />

                <Environment preset="city" />
            </Canvas>

            {/* Overlay Details */}
            <motion.div
                key={activeStrategy}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="absolute bottom-4 right-6 text-right z-10 pointer-events-none"
            >
                <div className="text-xs text-muted-foreground mb-1">WIN RATE</div>
                <div className="text-xl font-mono text-emerald-400">
                    {activeStrategy === 'RSI' ? '76%' : activeStrategy === 'BOLLINGER' ? '68%' : '71%'}
                </div>
            </motion.div>
        </div>
    );
}
