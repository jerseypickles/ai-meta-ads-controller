import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial, Ring } from '@react-three/drei';
import * as THREE from 'three';

/**
 * ImpactOrb — 3D visualization of follow-up performance.
 *
 * The orb color reflects win rate health:
 *   >70% → emerald green (thriving)
 *   50-70% → blue (learning)
 *   30-50% → amber (caution)
 *   <30% → red (underperforming)
 *
 * Orbiting rings represent measurement phases (3d, 7d, 14d).
 * Particles are colored by verdict distribution.
 * Distortion intensity maps to total measured volume.
 */

function ImpactSphere({ winRate = 0, activity = 0, totalMeasured = 0 }) {
  const meshRef = useRef();
  const glowRef = useRef();

  const colors = useMemo(() => {
    if (winRate >= 70) return { main: '#10b981', glow: '#34d399', emissive: '#059669' };
    if (winRate >= 50) return { main: '#3b82f6', glow: '#60a5fa', emissive: '#2563eb' };
    if (winRate >= 30) return { main: '#f59e0b', glow: '#fbbf24', emissive: '#d97706' };
    return { main: '#ef4444', glow: '#f87171', emissive: '#dc2626' };
  }, [winRate]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      // Slow confident rotation — faster with more data
      const rotSpeed = 0.08 + (Math.min(totalMeasured, 30) / 30) * 0.12;
      meshRef.current.rotation.y = t * rotSpeed;
      meshRef.current.rotation.x = Math.sin(t * 0.25) * 0.08;
      // Gentle pulse — amplitude increases with win rate
      const pulseAmp = 0.02 + (winRate / 100) * 0.03;
      meshRef.current.scale.setScalar(1 + Math.sin(t * 0.6) * pulseAmp);
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1.05 + Math.sin(t * 0.4) * 0.06);
      glowRef.current.material.opacity = 0.06 + Math.sin(t * 0.8) * 0.03;
    }
  });

  // More data = more confident distortion (less chaotic)
  const distort = totalMeasured > 10 ? 0.15 : totalMeasured > 3 ? 0.25 : 0.35;
  const speed = 1.0 + activity * 2;

  return (
    <group>
      {/* Outer glow */}
      <Sphere ref={glowRef} args={[1.35, 32, 32]}>
        <meshBasicMaterial
          color={colors.glow}
          transparent
          opacity={0.08}
          side={THREE.BackSide}
        />
      </Sphere>
      {/* Main sphere */}
      <Sphere ref={meshRef} args={[1, 64, 64]}>
        <MeshDistortMaterial
          color={colors.main}
          emissive={colors.emissive}
          emissiveIntensity={0.25}
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
 * Three concentric rings representing measurement phases.
 * Each ring lights up when its phase has data.
 * Colors: day_3 = cyan, day_7 = blue, day_14 = indigo
 */
function PhaseRings({ phases = {} }) {
  const ring3Ref = useRef();
  const ring7Ref = useRef();
  const ring14Ref = useRef();

  const ringConfig = useMemo(() => [
    { ref: ring3Ref, radius: 1.5, active: !!phases.day_3, color: '#22d3ee', label: '3d' },
    { ref: ring7Ref, radius: 1.8, active: !!phases.day_7, color: '#3b82f6', label: '7d' },
    { ref: ring14Ref, radius: 2.1, active: !!phases.day_14, color: '#8b5cf6', label: '14d' },
  ], [phases]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    ringConfig.forEach((cfg, i) => {
      if (cfg.ref.current) {
        // Each ring rotates at different speed and axis tilt
        cfg.ref.current.rotation.x = Math.PI / 2 + Math.sin(t * (0.15 + i * 0.05)) * 0.15;
        cfg.ref.current.rotation.z = t * (0.12 - i * 0.03);
      }
    });
  });

  return (
    <group>
      {ringConfig.map((cfg, i) => (
        <Ring
          key={cfg.label}
          ref={cfg.ref}
          args={[cfg.radius - 0.015, cfg.radius + 0.015, 64]}
        >
          <meshBasicMaterial
            color={cfg.color}
            transparent
            opacity={cfg.active ? 0.5 : 0.1}
            side={THREE.DoubleSide}
          />
        </Ring>
      ))}
    </group>
  );
}

/**
 * Verdict particles — green for positive, red for negative, gray for neutral.
 * Distributed in a sphere around the orb.
 */
function VerdictParticles({ positive = 0, negative = 0, neutral = 0 }) {
  const ref = useRef();
  const total = positive + negative + neutral;
  const count = Math.min(total * 3, 80);

  const { positions, colors } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);

    const green = new THREE.Color('#10b981');
    const red = new THREE.Color('#ef4444');
    const gray = new THREE.Color('#6b7280');

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 1.6 + Math.random() * 1.0;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);

      // Color based on verdict distribution
      const ratio = i / count;
      const posRatio = total > 0 ? positive / total : 0.33;
      const negRatio = total > 0 ? negative / total : 0.33;
      let c;
      if (ratio < posRatio) c = green;
      else if (ratio < posRatio + negRatio) c = red;
      else c = gray;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    return { positions: pos, colors: col };
  }, [count, positive, negative, neutral, total]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.03;
      ref.current.rotation.x = Math.sin(state.clock.getElapsedTime() * 0.08) * 0.05;
    }
  });

  if (count === 0) return null;

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-color" count={count} array={colors} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        size={0.04}
        vertexColors
        transparent
        opacity={0.65}
        sizeAttenuation
      />
    </points>
  );
}

/**
 * ImpactOrb — Main exported component.
 *
 * Props:
 *   winRate:  0-100 (percentage of positive verdicts)
 *   summary:  { total_measured, positive, negative, neutral, pending_follow_up }
 *   latestPhases: { day_3: bool, day_7: bool, day_14: bool } — which phases have data
 */
export default function ImpactOrb({
  winRate = 0,
  summary = {},
  latestPhases = {}
}) {
  const { total_measured = 0, positive = 0, negative = 0, neutral = 0, pending_follow_up = 0 } = summary;

  const activity = useMemo(() => {
    if (pending_follow_up > 5) return 0.8;
    if (pending_follow_up > 0) return 0.4;
    if (total_measured > 10) return 0.2;
    return 0.1;
  }, [pending_follow_up, total_measured]);

  // Status label
  const statusText = useMemo(() => {
    if (total_measured === 0) return 'Sin mediciones';
    if (winRate >= 70) return `${winRate}% efectividad`;
    if (winRate >= 50) return `${winRate}% — aprendiendo`;
    return `${winRate}% — necesita ajustes`;
  }, [winRate, total_measured]);

  const statusClass = winRate >= 70 ? 'healthy' : winRate >= 50 ? 'normal' : winRate >= 30 ? 'warning' : 'critical';

  return (
    <div className="impact-orb-container">
      <div className="impact-orb-canvas">
        <Canvas
          camera={{ position: [0, 0, 4.5], fov: 42 }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.35} />
          <pointLight position={[4, 4, 5]} intensity={0.7} color="#10b981" />
          <pointLight position={[-4, -2, 3]} intensity={0.35} color="#3b82f6" />
          <ImpactSphere
            winRate={winRate}
            activity={activity}
            totalMeasured={total_measured}
          />
          <PhaseRings phases={latestPhases} />
          <VerdictParticles
            positive={positive}
            negative={negative}
            neutral={neutral}
          />
        </Canvas>
      </div>
      <div className="impact-orb-stats">
        <div className="impact-orb-winrate">
          <span className={`impact-orb-dot ${statusClass}`} />
          <span className="impact-orb-pct">{winRate}%</span>
          <span className="impact-orb-label">win rate</span>
        </div>
        <div className="impact-orb-counts">
          <span className="impact-count positive">{positive}</span>
          <span className="impact-sep">/</span>
          <span className="impact-count negative">{negative}</span>
          <span className="impact-sep">/</span>
          <span className="impact-count neutral">{neutral}</span>
        </div>
      </div>
    </div>
  );
}
