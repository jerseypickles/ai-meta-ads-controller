import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Small health orb — reacts to account ROAS health.
 */
function HealthOrb({ health = 'normal' }) {
  const meshRef = useRef();
  const glowRef = useRef();

  const colors = useMemo(() => {
    const map = {
      excellent: { main: '#10b981', glow: '#34d399' },
      good:      { main: '#3b82f6', glow: '#60a5fa' },
      warning:   { main: '#f59e0b', glow: '#fbbf24' },
      critical:  { main: '#ef4444', glow: '#ff6b6b' },
      normal:    { main: '#6366f1', glow: '#818cf8' },
    };
    return map[health] || map.normal;
  }, [health]);

  const speed = health === 'critical' ? 3 : health === 'warning' ? 2 : 1.2;
  const distort = health === 'critical' ? 0.4 : health === 'warning' ? 0.3 : 0.2;

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      const breathe = 1 + Math.sin(t * 0.9) * 0.03;
      meshRef.current.scale.setScalar(breathe);
      meshRef.current.rotation.y = t * 0.2;
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1 + Math.sin(t * 0.7) * 0.06);
      glowRef.current.material.opacity = 0.06 + Math.sin(t * 1.4) * 0.03;
    }
  });

  return (
    <group>
      <Sphere ref={glowRef} args={[1.3, 24, 24]}>
        <meshBasicMaterial color={colors.glow} transparent opacity={0.08} side={THREE.BackSide} />
      </Sphere>
      <Sphere ref={meshRef} args={[1, 48, 48]}>
        <MeshDistortMaterial
          color={colors.main}
          emissive={colors.main}
          emissiveIntensity={0.35}
          roughness={0.15}
          metalness={0.85}
          distort={distort}
          speed={speed}
          transparent
          opacity={0.9}
        />
      </Sphere>
    </group>
  );
}

/**
 * AccountOrb — Compact 3D orb for the Ad Sets Manager header.
 * Color/distortion driven by account ROAS health.
 */
export default function AccountOrb({ roas = 0, roasTarget = 3, roasMinimum = 1.5, roasExcellent = 5 }) {
  const health = useMemo(() => {
    if (roas >= roasExcellent) return 'excellent';
    if (roas >= roasTarget) return 'good';
    if (roas >= roasMinimum) return 'warning';
    if (roas > 0) return 'critical';
    return 'normal';
  }, [roas, roasTarget, roasMinimum, roasExcellent]);

  return (
    <div className="account-orb-wrap">
      <Canvas
        camera={{ position: [0, 0, 3.5], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.5} />
        <pointLight position={[3, 3, 3]} intensity={0.7} color="#818cf8" />
        <pointLight position={[-3, -2, 1]} intensity={0.3} color="#3b82f6" />
        <HealthOrb health={health} />
      </Canvas>
    </div>
  );
}
