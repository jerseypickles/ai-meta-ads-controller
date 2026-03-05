import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

/**
 * Neural core — the central pulsating orb with layered glow shells.
 * Higher quality: dual-shell glow, inner fresnel rim, variable distortion.
 */
function NeuralCore({ activity = 0, severity = 'normal' }) {
  const coreRef = useRef();
  const innerGlowRef = useRef();
  const outerGlowRef = useRef();
  const rimRef = useRef();

  const colors = useMemo(() => {
    const map = {
      critical: { core: '#ef4444', glow: '#ff6b6b', rim: '#fca5a5' },
      warning:  { core: '#f59e0b', glow: '#fbbf24', rim: '#fde68a' },
      healthy:  { core: '#6366f1', glow: '#818cf8', rim: '#a5b4fc' },
      normal:   { core: '#7c3aed', glow: '#8b5cf6', rim: '#c4b5fd' },
    };
    return map[severity] || map.normal;
  }, [severity]);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();

    if (coreRef.current) {
      // Organic breathing — faster when active
      const breatheSpeed = 0.6 + activity * 0.8;
      const breatheAmp = 0.03 + activity * 0.04;
      const breathe = 1 + Math.sin(t * breatheSpeed) * breatheAmp;
      coreRef.current.scale.setScalar(breathe);
      coreRef.current.rotation.y = t * 0.12;
      coreRef.current.rotation.x = Math.sin(t * 0.2) * 0.08;
    }

    if (innerGlowRef.current) {
      const s = 1.15 + Math.sin(t * 0.9) * 0.05;
      innerGlowRef.current.scale.setScalar(s);
      innerGlowRef.current.material.opacity = 0.12 + Math.sin(t * 1.5) * 0.06;
    }

    if (outerGlowRef.current) {
      const s = 1.5 + Math.sin(t * 0.4) * 0.1;
      outerGlowRef.current.scale.setScalar(s);
      outerGlowRef.current.material.opacity = 0.04 + Math.sin(t * 0.7) * 0.02;
    }

    if (rimRef.current) {
      rimRef.current.rotation.z = t * 0.3;
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
 * They pulse and vary in brightness based on activity.
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
      groupRef.current.rotation.y = t * 0.08;
      groupRef.current.rotation.x = Math.sin(t * 0.06) * 0.05;
    }
    for (let i = 0; i < nodes.length; i++) {
      const ref = nodeRefs.current[i];
      if (ref) {
        const pulse = 1 + Math.sin(t * nodes[i].speed + nodes[i].phase) * 0.4;
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
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Neural connections — lines between random node pairs that pulse.
 * Creates the "neural network" visual.
 */
function NeuralConnections({ activity = 0, color = '#818cf8' }) {
  const linesRef = useRef();

  const connections = useMemo(() => {
    const points = [];
    const count = 6;
    for (let i = 0; i < count; i++) {
      // Start point on inner shell
      const t1 = Math.random() * Math.PI * 2;
      const p1 = Math.acos(2 * Math.random() - 1);
      const r1 = 0.9 + Math.random() * 0.2;
      // End point on outer shell
      const t2 = t1 + (Math.random() - 0.5) * 1.5;
      const p2 = p1 + (Math.random() - 0.5) * 0.8;
      const r2 = 1.5 + Math.random() * 0.5;

      points.push(
        r1 * Math.sin(p1) * Math.cos(t1),
        r1 * Math.sin(p1) * Math.sin(t1),
        r1 * Math.cos(p1),
        r2 * Math.sin(p2) * Math.cos(t2),
        r2 * Math.sin(p2) * Math.sin(t2),
        r2 * Math.cos(p2)
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
        <bufferAttribute
          attach="attributes-position"
          count={connections.length / 3}
          array={connections}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={0.15}
        linewidth={1}
      />
    </lineSegments>
  );
}

/** Floating ambient particles — subtle depth layer */
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
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.02}
        color={color}
        transparent
        opacity={0.4}
        sizeAttenuation
      />
    </points>
  );
}

/**
 * BrainOrb — Premium 3D neural orb for the Feed hero section.
 * Multi-layered: core + glow shells + synaptic nodes + connections + particles + orbital ring.
 */
export default function BrainOrb({ stats, unreadCount = 0, analyzing = false }) {
  const activity = useMemo(() => {
    if (analyzing) return 0.9;
    if (unreadCount > 10) return 0.6;
    if (unreadCount > 3) return 0.4;
    return 0.1;
  }, [unreadCount, analyzing]);

  const severity = useMemo(() => {
    if (analyzing) return 'warning';
    if (unreadCount > 10) return 'critical';
    if (unreadCount > 0) return 'normal';
    return 'healthy';
  }, [unreadCount, analyzing]);

  const accentColor = useMemo(() => {
    const map = { critical: '#fca5a5', warning: '#fde68a', healthy: '#a5b4fc', normal: '#c4b5fd' };
    return map[severity] || '#c4b5fd';
  }, [severity]);

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
        <span className={`brain-orb-dot ${severity}`} />
        <span className="brain-orb-text">{statusText}</span>
      </div>
    </div>
  );
}
