import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Neural core — the central pulsating orb with layered glow shells.
 * Reacts to brainState: idle, analyzing, alert, thinking, approved, rejected
 */
function NeuralCore({ activity = 0, severity = 'normal' }) {
  const coreRef = useRef();
  const innerGlowRef = useRef();
  const outerGlowRef = useRef();
  const rimRef = useRef();

  const colors = useMemo(() => {
    const map = {
      critical:  { core: '#ef4444', glow: '#ff6b6b', rim: '#fca5a5' },
      warning:   { core: '#f59e0b', glow: '#fbbf24', rim: '#fde68a' },
      healthy:   { core: '#10b981', glow: '#34d399', rim: '#6ee7b7' },
      thinking:  { core: '#8b5cf6', glow: '#a78bfa', rim: '#c4b5fd' },
      approved:  { core: '#10b981', glow: '#34d399', rim: '#a7f3d0' },
      rejected:  { core: '#f97316', glow: '#fb923c', rim: '#fdba74' },
      normal:    { core: '#6366f1', glow: '#818cf8', rim: '#a5b4fc' },
    };
    return map[severity] || map.normal;
  }, [severity]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();

    if (coreRef.current) {
      const breatheSpeed = 0.6 + activity * 0.8;
      const breatheAmp = 0.03 + activity * 0.04;
      const breathe = 1 + Math.sin(t * breatheSpeed) * breatheAmp;
      coreRef.current.scale.setScalar(breathe);
      coreRef.current.rotation.y = t * (0.12 + activity * 0.15);
      coreRef.current.rotation.x = Math.sin(t * 0.2) * (0.08 + activity * 0.1);
    }

    if (innerGlowRef.current) {
      const s = 1.15 + Math.sin(t * 0.9) * 0.05;
      innerGlowRef.current.scale.setScalar(s);
      innerGlowRef.current.material.opacity = 0.12 + Math.sin(t * 1.5) * 0.06 + activity * 0.08;
    }

    if (outerGlowRef.current) {
      const s = 1.5 + Math.sin(t * 0.4) * 0.1;
      outerGlowRef.current.scale.setScalar(s);
      outerGlowRef.current.material.opacity = 0.04 + Math.sin(t * 0.7) * 0.02 + activity * 0.04;
    }

    if (rimRef.current) {
      rimRef.current.rotation.z = t * (0.3 + activity * 0.5);
      rimRef.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.15) * 0.1;
    }
  });

  const distortAmount = 0.25 + activity * 0.25;
  const distortSpeed = 1.2 + activity * 3.5;

  return (
    <group>
      {/* Outer diffuse glow */}
      <Sphere ref={outerGlowRef} args={[1, 32, 32]}>
        <meshBasicMaterial
          color={colors.glow}
          transparent
          opacity={0.05}
          side={THREE.BackSide}
        />
      </Sphere>

      {/* Inner glow shell */}
      <Sphere ref={innerGlowRef} args={[1, 32, 32]}>
        <meshBasicMaterial
          color={colors.rim}
          transparent
          opacity={0.12}
          side={THREE.BackSide}
        />
      </Sphere>

      {/* Core orb — distorted surface */}
      <Sphere ref={coreRef} args={[0.85, 64, 64]}>
        <MeshDistortMaterial
          color={colors.core}
          emissive={colors.core}
          emissiveIntensity={0.5 + activity * 0.3}
          roughness={0.15}
          metalness={0.85}
          distort={distortAmount}
          speed={distortSpeed}
          transparent
          opacity={0.94}
        />
      </Sphere>

      {/* Orbital ring */}
      <mesh ref={rimRef}>
        <torusGeometry args={[1.25, 0.008, 16, 100]} />
        <meshBasicMaterial
          color={colors.rim}
          transparent
          opacity={0.3 + activity * 0.2}
        />
      </mesh>
    </group>
  );
}

/**
 * Synaptic nodes — small glowing spheres orbiting at different radii.
 */
function SynapticNodes({ count = 8, activity = 0, color = '#818cf8' }) {
  const groupRef = useRef();
  const nodeRefs = useRef([]);

  const nodes = useMemo(() => {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const phi = Math.PI / 2 + (Math.random() - 0.5) * 1.2;
      const r = 1.4 + Math.random() * 0.6;
      arr.push({
        pos: [
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi)
        ],
        size: 0.03 + Math.random() * 0.04,
        speed: 0.3 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2
      });
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.rotation.y = t * (0.08 + activity * 0.1);
      groupRef.current.rotation.x = Math.sin(t * 0.06) * 0.05;
    }
    for (let i = 0; i < nodes.length; i++) {
      const ref = nodeRefs.current[i];
      if (ref) {
        const pulse = 1 + Math.sin(t * nodes[i].speed + nodes[i].phase) * (0.4 + activity * 0.4);
        ref.scale.setScalar(pulse);
        if (ref.material) {
          ref.material.opacity = 0.4 + Math.sin(t * nodes[i].speed * 1.5 + nodes[i].phase) * 0.3;
        }
      }
    }
  });

  return (
    <group ref={groupRef}>
      {nodes.map((node, i) => (
        <mesh
          key={i}
          ref={el => { nodeRefs.current[i] = el; }}
          position={node.pos}
        >
          <sphereGeometry args={[node.size, 12, 12]} />
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Neural connections — lines between random node pairs that pulse.
 */
function NeuralConnections({ activity = 0, color = '#818cf8' }) {
  const linesRef = useRef();

  const connections = useMemo(() => {
    const points = [];
    const count = 6;
    for (let i = 0; i < count; i++) {
      const t1 = Math.random() * Math.PI * 2;
      const p1 = Math.acos(2 * Math.random() - 1);
      const r1 = 0.9 + Math.random() * 0.2;
      const t2 = t1 + (Math.random() - 0.5) * 1.5;
      const p2 = p1 + (Math.random() - 0.5) * 0.8;
      const r2 = 1.5 + Math.random() * 0.5;

      points.push(
        r1 * Math.sin(p1) * Math.cos(t1), r1 * Math.sin(p1) * Math.sin(t1), r1 * Math.cos(p1),
        r2 * Math.sin(p2) * Math.cos(t2), r2 * Math.sin(p2) * Math.sin(t2), r2 * Math.cos(p2)
      );
    }
    return new Float32Array(points);
  }, []);

  useFrame((state) => {
    if (linesRef.current) {
      linesRef.current.rotation.y = state.clock.getElapsedTime() * 0.04;
      linesRef.current.material.opacity = 0.1 + activity * 0.15 + Math.sin(state.clock.getElapsedTime() * 0.8) * 0.05;
    }
  });

  return (
    <lineSegments ref={linesRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={connections.length / 3} array={connections} itemSize={3} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.15} linewidth={1} />
    </lineSegments>
  );
}

/** Floating ambient particles */
function AmbientParticles({ count = 30, color = '#818cf8' }) {
  const ref = useRef();

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 1.8 + Math.random() * 1.0;
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, [count]);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.getElapsedTime() * 0.03;
      ref.current.rotation.z = Math.sin(state.clock.getElapsedTime() * 0.05) * 0.05;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color={color} transparent opacity={0.4} sizeAttenuation />
    </points>
  );
}

/**
 * BrainOrb — Premium 3D neural orb with reactive brain states.
 *
 * brainState: 'idle' | 'analyzing' | 'alert' | 'thinking' | 'approved' | 'rejected'
 * thoughtText: streaming text shown below orb (e.g., "Analizando BROAD 5...")
 * pendingCount: number of pending recommendations
 * entityCount: number of monitored entities
 */
export default function BrainOrb({
  stats, unreadCount = 0, analyzing = false,
  brainState = null, thoughtText = '', pendingCount = 0, entityCount = 0
}) {
  // Derive state from props if brainState not explicitly set
  const effectiveState = useMemo(() => {
    if (brainState) return brainState;
    if (analyzing) return 'analyzing';
    if (unreadCount > 10) return 'alert';
    if (unreadCount > 0) return 'idle';
    return 'idle';
  }, [brainState, analyzing, unreadCount]);

  const activity = useMemo(() => {
    const map = { idle: 0.1, analyzing: 0.85, alert: 0.6, thinking: 0.5, approved: 0.3, rejected: 0.3 };
    return map[effectiveState] || 0.1;
  }, [effectiveState]);

  const severity = useMemo(() => {
    const map = { idle: 'healthy', analyzing: 'warning', alert: 'critical', thinking: 'thinking', approved: 'approved', rejected: 'rejected' };
    return map[effectiveState] || 'normal';
  }, [effectiveState]);

  const accentColor = useMemo(() => {
    const map = {
      critical: '#fca5a5', warning: '#fde68a', healthy: '#a5b4fc',
      thinking: '#c4b5fd', approved: '#a7f3d0', rejected: '#fdba74', normal: '#c4b5fd'
    };
    return map[severity] || '#c4b5fd';
  }, [severity]);

  const statusText = useMemo(() => {
    if (thoughtText) return thoughtText;
    const texts = {
      analyzing: 'Procesando patrones...',
      alert: `${unreadCount} alerta${unreadCount > 1 ? 's' : ''} detectada${unreadCount > 1 ? 's' : ''}`,
      thinking: 'Evaluando acciones...',
      approved: 'Accion confirmada',
      rejected: 'Decision registrada',
    };
    if (texts[effectiveState]) return texts[effectiveState];
    // idle
    const parts = [];
    if (entityCount > 0) parts.push(`${entityCount} entidades`);
    if (pendingCount > 0) parts.push(`${pendingCount} pendiente${pendingCount > 1 ? 's' : ''}`);
    if (unreadCount > 0) parts.push(`${unreadCount} sin leer`);
    return parts.length > 0 ? parts.join(' | ') : 'Monitoreo activo';
  }, [effectiveState, thoughtText, unreadCount, pendingCount, entityCount]);

  const stateLabel = useMemo(() => {
    const labels = {
      idle: 'Monitoreando', analyzing: 'Analizando', alert: 'Alerta',
      thinking: 'Pensando', approved: 'Aprobado', rejected: 'Rechazado'
    };
    return labels[effectiveState] || 'Activo';
  }, [effectiveState]);

  return (
    <div className="brain-orb-container">
      <div className="brain-orb-canvas">
        <Canvas
          camera={{ position: [0, 0, 4], fov: 45 }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.3} />
          <pointLight position={[4, 4, 4]} intensity={0.7} color="#818cf8" />
          <pointLight position={[-4, -2, 3]} intensity={0.3} color="#6366f1" />
          <pointLight position={[0, -4, 2]} intensity={0.2} color="#3b82f6" />
          <NeuralCore activity={activity} severity={severity} />
          <SynapticNodes count={10} activity={activity} color={accentColor} />
          <NeuralConnections activity={activity} color={accentColor} />
          <AmbientParticles count={35} color={accentColor} />
        </Canvas>
      </div>
      <div className="brain-orb-status">
        <span className={`brain-orb-dot ${effectiveState}`} />
        <span className="brain-orb-label">{stateLabel}</span>
      </div>
      <div className={`brain-orb-thought ${effectiveState}`}>
        {statusText}
      </div>
    </div>
  );
}
