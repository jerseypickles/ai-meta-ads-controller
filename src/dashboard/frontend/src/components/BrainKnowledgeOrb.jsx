import React, { useRef, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial, Html } from '@react-three/drei';
import * as THREE from 'three';

/**
 * BrainKnowledgeOrb — 3D neural network visualization of the Brain's knowledge.
 *
 * 4 knowledge zones represented as node clusters:
 *   Blue:   Entity memories (action_history per ad set)
 *   Purple: Hypotheses (validated/active/rejected)
 *   Orange: Temporal patterns (day-of-week baselines)
 *   Green:  Thompson Sampling (policy learning)
 *
 * Nodes pulse and connect with synaptic lines.
 * The central core represents the Brain IQ.
 */

const ZONE_COLORS = {
  memory:   { main: '#3b82f6', glow: '#60a5fa', emissive: '#2563eb' },
  hypothesis: { main: '#a855f7', glow: '#c084fc', emissive: '#7c3aed' },
  temporal: { main: '#f97316', glow: '#fb923c', emissive: '#ea580c' },
  policy:   { main: '#10b981', glow: '#34d399', emissive: '#059669' },
};

/* ── Central Brain Core ── */
function BrainCore({ iq = 50 }) {
  const meshRef = useRef();
  const glowRef = useRef();

  // IQ drives color: low=red, mid=blue, high=green
  const color = useMemo(() => {
    if (iq >= 75) return { main: '#10b981', glow: '#34d399' };
    if (iq >= 55) return { main: '#6366f1', glow: '#818cf8' };
    if (iq >= 40) return { main: '#3b82f6', glow: '#60a5fa' };
    return { main: '#f59e0b', glow: '#fbbf24' };
  }, [iq]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      const breathe = 1 + Math.sin(t * 0.5) * 0.03;
      meshRef.current.scale.setScalar(breathe);
      meshRef.current.rotation.y = t * 0.08;
      meshRef.current.rotation.x = Math.sin(t * 0.2) * 0.05;
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1.05 + Math.sin(t * 0.4) * 0.06);
      glowRef.current.material.opacity = 0.06 + Math.sin(t * 0.8) * 0.03;
    }
  });

  const distort = 0.15 + (iq / 100) * 0.1;

  return (
    <group>
      <Sphere ref={glowRef} args={[1.2, 32, 32]}>
        <meshBasicMaterial color={color.glow} transparent opacity={0.07} side={THREE.BackSide} />
      </Sphere>
      <Sphere ref={meshRef} args={[0.8, 64, 64]}>
        <MeshDistortMaterial
          color={color.main}
          emissive={color.main}
          emissiveIntensity={0.3}
          roughness={0.15}
          metalness={0.85}
          distort={distort}
          speed={1.2}
          transparent
          opacity={0.88}
        />
      </Sphere>
    </group>
  );
}

/* ── Knowledge Node ── */
function KnowledgeNode({ position, zone, size = 0.18, pulseSpeed = 1, intensity = 1, label, onHover }) {
  const meshRef = useRef();
  const colors = ZONE_COLORS[zone] || ZONE_COLORS.memory;
  const baseSize = size * (0.6 + intensity * 0.4);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      const pulse = 1 + Math.sin(t * pulseSpeed + position[0] * 2) * 0.12;
      meshRef.current.scale.setScalar(pulse);
    }
  });

  return (
    <group position={position}>
      {/* Glow */}
      <Sphere args={[baseSize * 1.8, 12, 12]}>
        <meshBasicMaterial color={colors.glow} transparent opacity={0.06} side={THREE.BackSide} />
      </Sphere>
      {/* Node */}
      <Sphere
        ref={meshRef}
        args={[baseSize, 16, 16]}
        onPointerEnter={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover && onHover(label); }}
        onPointerLeave={(e) => { e.stopPropagation(); document.body.style.cursor = 'default'; onHover && onHover(null); }}
      >
        <meshStandardMaterial
          color={colors.main}
          emissive={colors.emissive}
          emissiveIntensity={0.5 * intensity}
          roughness={0.3}
          metalness={0.7}
          transparent
          opacity={0.9}
        />
      </Sphere>
    </group>
  );
}

/* ── Synaptic Connections ── */
function Synapses({ connections }) {
  const ref = useRef();

  const geometry = useMemo(() => {
    const points = [];
    for (const conn of connections) {
      points.push(new THREE.Vector3(...conn.from));
      points.push(new THREE.Vector3(...conn.to));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    return geo;
  }, [connections]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.material.opacity = 0.12 + Math.sin(state.clock.getElapsedTime() * 0.5) * 0.06;
    }
  });

  return (
    <lineSegments ref={ref} geometry={geometry}>
      <lineBasicMaterial color="#818cf8" transparent opacity={0.15} />
    </lineSegments>
  );
}

/* ── Ambient Particles ── */
function AmbientParticles({ count = 60 }) {
  const ref = useRef();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2.5 + Math.random() * 1.5;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.02;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#6366f1" transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}

/* ── Neural Network Scene ── */
function NeuralNetwork({ data, onHoverNode }) {
  const groupRef = useRef();
  const { nodes, connections } = useMemo(() => {
    const n = [];
    const c = [];

    // Zone 1: Memory nodes (top-right quadrant)
    const memCount = Math.min(data.entities_with_history || 0, 8);
    for (let i = 0; i < Math.max(memCount, 2); i++) {
      const angle = (i / Math.max(memCount, 2)) * Math.PI * 0.6 - Math.PI * 0.1;
      const r = 1.6 + (i % 2) * 0.4;
      const entity = data.entity_memories?.[i];
      const actionCount = entity?.action_history?.length || 0;
      n.push({
        pos: [r * Math.cos(angle), r * Math.sin(angle) * 0.6 + 0.4, (i % 3 - 1) * 0.3],
        zone: 'memory',
        size: 0.12 + actionCount * 0.015,
        intensity: actionCount > 3 ? 1 : actionCount > 0 ? 0.6 : 0.3,
        pulse: 0.8 + actionCount * 0.1,
        label: entity ? `${entity.entity_name}: ${actionCount} acciones` : 'Sin historial'
      });
    }

    // Zone 2: Hypothesis nodes (top-left quadrant)
    const hyps = data.hypotheses || [];
    const hypCount = Math.max(hyps.length, 2);
    for (let i = 0; i < Math.min(hypCount, 6); i++) {
      const angle = Math.PI + (i / Math.min(hypCount, 6)) * Math.PI * 0.5 - Math.PI * 0.1;
      const r = 1.5 + (i % 2) * 0.4;
      const h = hyps[i];
      const intensity = h ? (h.status === 'confirmed' ? 1 : h.status === 'rejected' ? 0.3 : 0.7) : 0.2;
      n.push({
        pos: [r * Math.cos(angle), r * Math.sin(angle) * 0.6 + 0.3, (i % 2 - 0.5) * 0.5],
        zone: 'hypothesis',
        size: 0.14,
        intensity,
        pulse: h?.status === 'active' ? 1.5 : 0.5,
        label: h ? `${h.status === 'confirmed' ? '✓' : h.status === 'rejected' ? '✗' : '⟳'} ${h.hypothesis.substring(0, 50)}...` : 'Sin hipótesis'
      });
    }

    // Zone 3: Temporal nodes (bottom, 7 = days of week)
    const temporal = data.temporal_patterns || [];
    const dayLabels = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 0.8 + Math.PI * 1.1;
      const r = 1.7;
      const tp = temporal.find(t => t.day === ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][i]);
      const samples = tp?.sample_count || 0;
      n.push({
        pos: [r * Math.cos(angle), r * Math.sin(angle) * 0.5 - 0.6, (i % 3 - 1) * 0.2],
        zone: 'temporal',
        size: 0.1 + Math.min(samples, 10) * 0.012,
        intensity: samples >= 4 ? 1 : samples > 0 ? 0.5 : 0.15,
        pulse: tp?.is_today ? 2 : 0.6,
        label: `${dayLabels[i]}: ${samples} muestras${tp?.is_today ? ' (HOY)' : ''}${tp?.metrics?.avg_roas ? ` · ROAS ${tp.metrics.avg_roas.toFixed(2)}` : ''}`
      });
    }

    // Zone 4: Policy/Thompson nodes (right side)
    const actions = data.policy?.top_actions || [];
    for (let i = 0; i < Math.min(actions.length, 5); i++) {
      const angle = -Math.PI * 0.35 + (i / Math.min(actions.length, 5)) * Math.PI * 0.5;
      const r = 1.8;
      const a = actions[i];
      n.push({
        pos: [r * Math.cos(angle) + 0.3, r * Math.sin(angle) * 0.5, (i % 2 - 0.5) * 0.4],
        zone: 'policy',
        size: 0.12 + (a.count / 20) * 0.08,
        intensity: a.success_rate > 60 ? 1 : a.success_rate > 45 ? 0.6 : 0.3,
        pulse: 0.6 + a.count * 0.05,
        label: `${a.action}: ${a.count} muestras · ${a.success_rate}% éxito`
      });
    }

    // Connections: from core (0,0,0) to each node + inter-zone connections
    for (const node of n) {
      c.push({ from: [0, 0, 0], to: node.pos });
    }
    // Connect adjacent nodes within same zone
    const byZone = {};
    for (const node of n) {
      if (!byZone[node.zone]) byZone[node.zone] = [];
      byZone[node.zone].push(node);
    }
    for (const zone of Object.values(byZone)) {
      for (let i = 0; i < zone.length - 1; i++) {
        c.push({ from: zone[i].pos, to: zone[i + 1].pos });
      }
    }

    return { nodes: n, connections: c };
  }, [data]);

  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.getElapsedTime() * 0.03;
    }
  });

  return (
    <group ref={groupRef}>
      <BrainCore iq={data.iq_score || 50} />
      <Synapses connections={connections} />
      {nodes.map((node, i) => (
        <KnowledgeNode
          key={i}
          position={node.pos}
          zone={node.zone}
          size={node.size}
          pulseSpeed={node.pulse}
          intensity={node.intensity}
          label={node.label}
          onHover={onHoverNode}
        />
      ))}
      <AmbientParticles count={50} />
    </group>
  );
}

/* ── Main Component ── */
export default function BrainKnowledgeOrb({ data }) {
  const [hoveredLabel, setHoveredLabel] = useState(null);

  return (
    <div className="knowledge-orb-container">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.35} />
        <pointLight position={[5, 5, 5]} intensity={0.6} color="#818cf8" />
        <pointLight position={[-5, -3, 3]} intensity={0.3} color="#3b82f6" />
        <pointLight position={[0, -4, 2]} intensity={0.2} color="#f97316" />
        <NeuralNetwork data={data} onHoverNode={setHoveredLabel} />
      </Canvas>
      {hoveredLabel && (
        <div className="knowledge-orb-tooltip">
          {hoveredLabel}
        </div>
      )}
      {/* Zone legend */}
      <div className="knowledge-orb-legend">
        <span className="legend-dot memory" /> Memoria
        <span className="legend-dot hypothesis" /> Hipótesis
        <span className="legend-dot temporal" /> Temporal
        <span className="legend-dot policy" /> Decisiones
      </div>
    </div>
  );
}
