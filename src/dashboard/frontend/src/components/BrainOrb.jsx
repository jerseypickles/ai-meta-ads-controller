import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Animated neural orb — represents the Brain "thinking".
 * Pulses and distorts based on activity level.
 */
function NeuralOrb({ activity = 0, severity = 'normal' }) {
  const meshRef = useRef();
  const glowRef = useRef();

  // Color based on account health / severity
  const colors = useMemo(() => {
    const map = {
      critical: { main: '#ef4444', glow: '#ff6b6b' },
      warning:  { main: '#f59e0b', glow: '#fbbf24' },
      healthy:  { main: '#3b82f6', glow: '#60a5fa' },
      normal:   { main: '#6366f1', glow: '#818cf8' },
    };
    return map[severity] || map.normal;
  }, [severity]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      // Gentle breathing pulse
      const breathe = 1 + Math.sin(t * 0.8) * 0.04;
      meshRef.current.scale.setScalar(breathe);
      meshRef.current.rotation.y = t * 0.15;
      meshRef.current.rotation.x = Math.sin(t * 0.3) * 0.1;
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1 + Math.sin(t * 0.6) * 0.08);
      glowRef.current.material.opacity = 0.08 + Math.sin(t * 1.2) * 0.04;
    }
  });

  // Distortion speed increases with activity
  const distortSpeed = 1.5 + (activity * 3);
  const distortAmount = 0.3 + (activity * 0.2);

  return (
    <group>
      {/* Outer glow */}
      <Sphere ref={glowRef} args={[1.4, 32, 32]}>
        <meshBasicMaterial
          color={colors.glow}
          transparent
          opacity={0.1}
          side={THREE.BackSide}
        />
      </Sphere>
      {/* Main orb */}
      <Sphere ref={meshRef} args={[1, 64, 64]}>
        <MeshDistortMaterial
          color={colors.main}
          emissive={colors.main}
          emissiveIntensity={0.3}
          roughness={0.2}
          metalness={0.8}
          distort={distortAmount}
          speed={distortSpeed}
          transparent
          opacity={0.92}
        />
      </Sphere>
    </group>
  );
}

/** Floating particles around the orb */
function Particles({ count = 40 }) {
  const ref = useRef();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 1.6 + Math.random() * 1.2;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.05;
      ref.current.rotation.x = Math.sin(state.clock.getElapsedTime() * 0.1) * 0.1;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        color="#818cf8"
        transparent
        opacity={0.6}
        sizeAttenuation
      />
    </points>
  );
}

/**
 * BrainOrb — Full 3D header component.
 * Shows an animated orb + status text.
 */
export default function BrainOrb({ stats, unreadCount = 0, analyzing = false }) {
  // Determine activity level (0-1) based on unread/analysis
  const activity = useMemo(() => {
    if (analyzing) return 0.9;
    if (unreadCount > 10) return 0.6;
    if (unreadCount > 3) return 0.4;
    return 0.1;
  }, [unreadCount, analyzing]);

  // Determine severity
  const severity = useMemo(() => {
    if (analyzing) return 'warning';
    if (unreadCount > 10) return 'critical';
    if (unreadCount > 0) return 'normal';
    return 'healthy';
  }, [unreadCount, analyzing]);

  const statusText = analyzing
    ? 'Analizando...'
    : unreadCount > 0
      ? `${unreadCount} nuevo${unreadCount > 1 ? 's' : ''}`
      : 'Monitoreo activo';

  return (
    <div className="brain-orb-container">
      <div className="brain-orb-canvas">
        <Canvas
          camera={{ position: [0, 0, 4], fov: 45 }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.4} />
          <pointLight position={[5, 5, 5]} intensity={0.8} color="#818cf8" />
          <pointLight position={[-5, -3, 2]} intensity={0.4} color="#3b82f6" />
          <NeuralOrb activity={activity} severity={severity} />
          <Particles count={50} />
        </Canvas>
      </div>
      <div className="brain-orb-status">
        <span className={`brain-orb-dot ${severity}`} />
        <span className="brain-orb-text">{statusText}</span>
      </div>
    </div>
  );
}
