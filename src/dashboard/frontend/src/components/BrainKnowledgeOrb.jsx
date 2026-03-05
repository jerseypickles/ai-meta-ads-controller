import React, { useRef, useMemo, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/**
 * BrainKnowledgeOrb — 3D neural network visualization of the Brain's knowledge.
 *
 * Layout: 4 quadrants around a central core, each representing a knowledge zone.
 *   Top-left:     Purple — Hypotheses
 *   Top-right:    Blue   — Entity memories
 *   Bottom-left:  Green  — Thompson Sampling (decisions)
 *   Bottom-right: Orange — Temporal patterns (7 days)
 */

const ZONE_COLORS = {
  memory:     { main: '#3b82f6', glow: '#60a5fa', emissive: '#2563eb' },
  hypothesis: { main: '#a855f7', glow: '#c084fc', emissive: '#7c3aed' },
  temporal:   { main: '#f97316', glow: '#fb923c', emissive: '#ea580c' },
  policy:     { main: '#10b981', glow: '#34d399', emissive: '#059669' },
};

/* ── Central Brain Core ── */
function BrainCore({ iq = 50 }) {
  const meshRef = useRef();
  const glowRef = useRef();

  const color = useMemo(() => {
    if (iq >= 75) return { main: '#10b981', glow: '#34d399' };
    if (iq >= 55) return { main: '#6366f1', glow: '#818cf8' };
    if (iq >= 40) return { main: '#3b82f6', glow: '#60a5fa' };
    return { main: '#f59e0b', glow: '#fbbf24' };
  }, [iq]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      meshRef.current.scale.setScalar(1 + Math.sin(t * 0.5) * 0.025);
      meshRef.current.rotation.y = t * 0.06;
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1.05 + Math.sin(t * 0.4) * 0.04);
      glowRef.current.material.opacity = 0.06 + Math.sin(t * 0.8) * 0.025;
    }
  });

  return (
    <group>
      <Sphere ref={glowRef} args={[0.95, 32, 32]}>
        <meshBasicMaterial color={color.glow} transparent opacity={0.06} side={THREE.BackSide} />
      </Sphere>
      <Sphere ref={meshRef} args={[0.55, 48, 48]}>
        <MeshDistortMaterial
          color={color.main}
          emissive={color.main}
          emissiveIntensity={0.3}
          roughness={0.15}
          metalness={0.85}
          distort={0.18}
          speed={1.0}
          transparent
          opacity={0.88}
        />
      </Sphere>
    </group>
  );
}

/* ── Knowledge Node ── */
function KnowledgeNode({ position, zone, size = 0.15, pulseSpeed = 1, intensity = 1, label, onHover }) {
  const meshRef = useRef();
  const colors = ZONE_COLORS[zone] || ZONE_COLORS.memory;
  const baseSize = size * (0.5 + intensity * 0.5);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (meshRef.current) {
      meshRef.current.scale.setScalar(1 + Math.sin(t * pulseSpeed + position[0] * 3) * 0.1);
    }
  });

  return (
    <group position={position}>
      <Sphere args={[baseSize * 2, 10, 10]}>
        <meshBasicMaterial color={colors.glow} transparent opacity={0.04} side={THREE.BackSide} />
      </Sphere>
      <Sphere
        ref={meshRef}
        args={[baseSize, 16, 16]}
        onPointerEnter={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; onHover && onHover(label); }}
        onPointerLeave={(e) => { e.stopPropagation(); document.body.style.cursor = 'default'; onHover && onHover(null); }}
      >
        <meshStandardMaterial
          color={colors.main}
          emissive={colors.emissive}
          emissiveIntensity={0.4 * intensity}
          roughness={0.3}
          metalness={0.7}
          transparent
          opacity={0.85}
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
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [connections]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.material.opacity = 0.1 + Math.sin(state.clock.getElapsedTime() * 0.4) * 0.05;
    }
  });

  return (
    <lineSegments ref={ref} geometry={geometry}>
      <lineBasicMaterial color="#818cf8" transparent opacity={0.12} />
    </lineSegments>
  );
}

/* ── Ambient Particles ── */
function AmbientParticles({ count = 40 }) {
  const ref = useRef();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2.2 + Math.random() * 1.0;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.015;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.018} color="#6366f1" transparent opacity={0.3} sizeAttenuation />
    </points>
  );
}

/**
 * Place nodes in a distinct quadrant using a small arc.
 * cx, cy = center of the quadrant cluster
 * spread = angular spread within the quadrant
 */
function placeInQuadrant(cx, cy, count, spread, zOffset) {
  const positions = [];
  if (count <= 1) {
    positions.push([cx, cy, zOffset]);
    return positions;
  }
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? (i / (count - 1)) - 0.5 : 0; // -0.5 to 0.5
    const x = cx + t * spread;
    const y = cy + (Math.abs(t) * -0.3); // slight arc downward
    const z = zOffset + ((i % 2) - 0.5) * 0.25;
    positions.push([x, y, z]);
  }
  return positions;
}

/* ── Neural Network Scene ── */
function NeuralNetwork({ data, onHoverNode }) {
  const groupRef = useRef();

  const { nodes, connections } = useMemo(() => {
    const n = [];
    const c = [];

    // ── Zone 1: Memory (top-right) ──
    const memEntities = data.entity_memories || [];
    const memCount = Math.min(memEntities.length, 6);
    if (memCount > 0) {
      const positions = placeInQuadrant(1.3, 0.8, memCount, 1.2, 0);
      for (let i = 0; i < memCount; i++) {
        const entity = memEntities[i];
        const actionCount = entity?.action_history?.length || 0;
        n.push({
          pos: positions[i], zone: 'memory',
          size: 0.1 + Math.min(actionCount, 8) * 0.012,
          intensity: actionCount > 3 ? 1 : actionCount > 0 ? 0.65 : 0.3,
          pulse: 0.7 + Math.min(actionCount, 5) * 0.15,
          label: `${entity.entity_name}: ${actionCount} acciones`
        });
      }
    } else {
      // Single dim node to show the zone exists
      n.push({ pos: [1.3, 0.8, 0], zone: 'memory', size: 0.08, intensity: 0.15, pulse: 0.4, label: 'Memoria: sin historial aun' });
    }

    // ── Zone 2: Hypotheses (top-left) ──
    const hyps = data.hypotheses || [];
    const hypCount = Math.min(hyps.length, 5);
    if (hypCount > 0) {
      const positions = placeInQuadrant(-1.3, 0.8, hypCount, 1.1, 0);
      for (let i = 0; i < hypCount; i++) {
        const h = hyps[i];
        n.push({
          pos: positions[i], zone: 'hypothesis',
          size: 0.12,
          intensity: h.status === 'confirmed' ? 1 : h.status === 'rejected' ? 0.25 : 0.65,
          pulse: h.status === 'active' ? 1.4 : 0.4,
          label: `${h.status === 'confirmed' ? '\u2713' : h.status === 'rejected' ? '\u2717' : '\u27F3'} ${h.hypothesis.substring(0, 60)}`
        });
      }
    } else {
      n.push({ pos: [-1.3, 0.8, 0], zone: 'hypothesis', size: 0.08, intensity: 0.15, pulse: 0.4, label: 'Hipotesis: ninguna aun' });
    }

    // ── Zone 3: Temporal (bottom-right, 7 day nodes in a row) ──
    const temporal = data.temporal_patterns || [];
    const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayLabels = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
    const tempPositions = placeInQuadrant(1.0, -0.9, 7, 1.8, 0);
    for (let i = 0; i < 7; i++) {
      const tp = temporal.find(t => t.day === dayKeys[i]);
      const samples = tp?.sample_count || 0;
      n.push({
        pos: tempPositions[i], zone: 'temporal',
        size: 0.07 + Math.min(samples, 10) * 0.01,
        intensity: samples >= 4 ? 1 : samples > 0 ? 0.45 : 0.12,
        pulse: tp?.is_today ? 2.0 : 0.5,
        label: `${dayLabels[i]}: ${samples} muestras${tp?.is_today ? ' (HOY)' : ''}${tp?.metrics?.avg_roas ? ' \u00B7 ROAS ' + tp.metrics.avg_roas.toFixed(2) : ''}`
      });
    }

    // ── Zone 4: Policy / Thompson (bottom-left) ──
    const actions = data.policy?.top_actions || [];
    const polCount = Math.min(actions.length, 5);
    if (polCount > 0) {
      const positions = placeInQuadrant(-1.3, -0.9, polCount, 1.2, 0);
      for (let i = 0; i < polCount; i++) {
        const a = actions[i];
        n.push({
          pos: positions[i], zone: 'policy',
          size: 0.1 + Math.min(a.count, 20) * 0.004,
          intensity: a.success_rate > 60 ? 1 : a.success_rate > 45 ? 0.6 : 0.3,
          pulse: 0.5 + Math.min(a.count, 10) * 0.06,
          label: `${a.action}: ${a.count} muestras \u00B7 ${a.success_rate}% exito`
        });
      }
    } else {
      n.push({ pos: [-1.3, -0.9, 0], zone: 'policy', size: 0.08, intensity: 0.15, pulse: 0.4, label: 'Decisiones: sin datos aun' });
    }

    // ── Connections ──
    // Core to each zone center (4 main synapses)
    const zoneCenters = {
      memory: [1.3, 0.8, 0],
      hypothesis: [-1.3, 0.8, 0],
      temporal: [1.0, -0.9, 0],
      policy: [-1.3, -0.9, 0]
    };
    for (const center of Object.values(zoneCenters)) {
      c.push({ from: [0, 0, 0], to: center });
    }

    // Connect adjacent nodes within same zone
    const byZone = {};
    for (const node of n) {
      if (!byZone[node.zone]) byZone[node.zone] = [];
      byZone[node.zone].push(node);
    }
    for (const zoneNodes of Object.values(byZone)) {
      for (let i = 0; i < zoneNodes.length - 1; i++) {
        c.push({ from: zoneNodes[i].pos, to: zoneNodes[i + 1].pos });
      }
    }

    // Connect first node of each zone to center
    for (const zoneNodes of Object.values(byZone)) {
      if (zoneNodes.length > 0) {
        c.push({ from: [0, 0, 0], to: zoneNodes[0].pos });
        if (zoneNodes.length > 1) {
          c.push({ from: [0, 0, 0], to: zoneNodes[zoneNodes.length - 1].pos });
        }
      }
    }

    return { nodes: n, connections: c };
  }, [data]);

  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.getElapsedTime() * 0.025;
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
      <AmbientParticles count={40} />
    </group>
  );
}

/* ── Main Component ── */
export default function BrainKnowledgeOrb({ data }) {
  const [hoveredLabel, setHoveredLabel] = useState(null);

  return (
    <div className="knowledge-orb-container">
      <Canvas
        camera={{ position: [0, 0, 4.8], fov: 48 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.4} />
        <pointLight position={[4, 3, 5]} intensity={0.5} color="#818cf8" />
        <pointLight position={[-4, -2, 3]} intensity={0.25} color="#3b82f6" />
        <pointLight position={[0, -3, 2]} intensity={0.15} color="#f97316" />
        <NeuralNetwork data={data} onHoverNode={setHoveredLabel} />
      </Canvas>
      {hoveredLabel && (
        <div className="knowledge-orb-tooltip">
          {hoveredLabel}
        </div>
      )}
      <div className="knowledge-orb-legend">
        <span className="legend-dot memory" /> Memoria
        <span className="legend-dot hypothesis" /> Hipotesis
        <span className="legend-dot temporal" /> Temporal
        <span className="legend-dot policy" /> Decisiones
      </div>
    </div>
  );
}
