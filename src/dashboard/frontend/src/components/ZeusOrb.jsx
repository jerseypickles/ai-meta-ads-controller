import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════════
// COLORES DE AGENTES
// ═══════════════════════════════════════════════════════════════════
const ZEUS_COLOR = new THREE.Color('#fbbf24');
const ZEUS_ACTIVE = new THREE.Color('#f97316');
const ATHENA_COLOR = new THREE.Color('#3b82f6');
const APOLLO_COLOR = new THREE.Color('#f59e0b');
const PROMETHEUS_COLOR = new THREE.Color('#f97316');

const AGENT_CONFIG = [
  { key: 'athena', name: 'Athena', color: ATHENA_COLOR, angle: 0, radius: 2.2, speed: 0.15 },
  { key: 'apollo', name: 'Apollo', color: APOLLO_COLOR, angle: (Math.PI * 2) / 3, radius: 2.0, speed: 0.12 },
  { key: 'prometheus', name: 'Prometheus', color: PROMETHEUS_COLOR, angle: (Math.PI * 4) / 3, radius: 2.4, speed: 0.18 }
];

// ═══════════════════════════════════════════════════════════════════
// ZEUS CORE — Nodo central pulsante dorado
// ═══════════════════════════════════════════════════════════════════
function ZeusCore({ learningActive, intelligence }) {
  const coreRef = useRef();
  const glowRef = useRef();
  const innerGlowRef = useRef();
  const ringRef = useRef();

  const activity = learningActive ? 0.85 : 0.3;
  const coreColor = learningActive ? ZEUS_ACTIVE : ZEUS_COLOR;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (coreRef.current) {
      coreRef.current.rotation.y = t * (0.1 + activity * 0.2);
      coreRef.current.rotation.x = Math.sin(t * 0.3) * 0.1;
      const pulse = 1 + Math.sin(t * (0.5 + activity * 0.5)) * (0.02 + activity * 0.05);
      coreRef.current.scale.setScalar(pulse);
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(1 + Math.sin(t * 0.4) * 0.06);
      glowRef.current.material.opacity = 0.04 + Math.sin(t * 0.6) * 0.02;
    }
    if (innerGlowRef.current) {
      innerGlowRef.current.material.opacity = 0.08 + Math.sin(t * 0.8) * 0.04;
    }
    if (ringRef.current) {
      ringRef.current.rotation.z = t * 0.3;
      ringRef.current.rotation.x = Math.sin(t * 0.2) * 0.3;
    }
  });

  return (
    <group>
      {/* Glow exterior */}
      <Sphere ref={glowRef} args={[1.2, 32, 32]}>
        <meshBasicMaterial color={coreColor} transparent opacity={0.05} side={THREE.BackSide} />
      </Sphere>
      {/* Glow interior */}
      <Sphere ref={innerGlowRef} args={[1.0, 32, 32]}>
        <meshBasicMaterial color={coreColor} transparent opacity={0.1} side={THREE.BackSide} />
      </Sphere>
      {/* Core con distorsion */}
      <Sphere ref={coreRef} args={[0.7, 64, 64]}>
        <MeshDistortMaterial
          color={coreColor}
          emissive={coreColor}
          emissiveIntensity={0.5 + activity * 0.3}
          metalness={0.9}
          roughness={0.1}
          distort={0.2 + activity * 0.3}
          speed={1.0 + activity * 3.0}
        />
      </Sphere>
      {/* Anillo orbital */}
      <mesh ref={ringRef}>
        <torusGeometry args={[1.1, 0.008, 16, 100]} />
        <meshBasicMaterial color={coreColor} transparent opacity={0.3} />
      </mesh>
      {/* Segundo anillo perpendicular */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.95, 0.006, 16, 80]} />
        <meshBasicMaterial color={coreColor} transparent opacity={0.15} />
      </mesh>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════
// AGENT NODES — 3 nodos orbitando con color de cada agente
// ═══════════════════════════════════════════════════════════════════
function AgentNodes({ agentStats }) {
  const groupRef = useRef();
  const nodeRefs = useRef([]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    AGENT_CONFIG.forEach((agent, i) => {
      const ref = nodeRefs.current[i];
      if (!ref) return;
      const angle = agent.angle + t * agent.speed;
      const r = agent.radius;
      ref.position.x = Math.cos(angle) * r;
      ref.position.z = Math.sin(angle) * r;
      ref.position.y = Math.sin(t * 0.3 + i * 2) * 0.3;
      // Pulso de tamaño
      const stats = agentStats?.[agent.key];
      const activity = stats?.active ? 1.0 : 0.5;
      const pulse = 1 + Math.sin(t * (0.8 + i * 0.3)) * 0.08 * activity;
      ref.scale.setScalar(pulse);
    });
  });

  return (
    <group ref={groupRef}>
      {AGENT_CONFIG.map((agent, i) => {
        const stats = agentStats?.[agent.key];
        const size = stats?.active ? 0.25 : 0.15;
        return (
          <group key={agent.key} ref={el => nodeRefs.current[i] = el}>
            {/* Glow del nodo */}
            <Sphere args={[size * 2, 16, 16]}>
              <meshBasicMaterial color={agent.color} transparent opacity={0.06} side={THREE.BackSide} />
            </Sphere>
            {/* Nodo principal */}
            <Sphere args={[size, 24, 24]}>
              <MeshDistortMaterial
                color={agent.color}
                emissive={agent.color}
                emissiveIntensity={0.4}
                metalness={0.8}
                roughness={0.2}
                distort={0.15}
                speed={1.5}
              />
            </Sphere>
          </group>
        );
      })}
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SYNAPSES — Lineas pulsantes Zeus <-> Agentes
// ═══════════════════════════════════════════════════════════════════
function Synapses({ agentStats, directiveCount }) {
  const linesRef = useRef();

  const { positions, colors } = useMemo(() => {
    const pos = [];
    const col = [];
    AGENT_CONFIG.forEach(agent => {
      // Linea del centro al agente (posicion inicial)
      const angle = agent.angle;
      const r = agent.radius;
      pos.push(0, 0, 0);
      pos.push(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      // Colores: Zeus dorado al color del agente
      col.push(1, 0.75, 0.15); // dorado
      col.push(agent.color.r, agent.color.g, agent.color.b);
    });
    return {
      positions: new Float32Array(pos),
      colors: new Float32Array(col)
    };
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!linesRef.current) return;
    const geo = linesRef.current.geometry;
    const posAttr = geo.attributes.position;

    AGENT_CONFIG.forEach((agent, i) => {
      const angle = agent.angle + t * agent.speed;
      const r = agent.radius;
      // Actualizar posicion del endpoint (el nodo se mueve)
      posAttr.setXYZ(i * 2 + 1,
        Math.cos(angle) * r,
        Math.sin(t * 0.3 + i * 2) * 0.3,
        Math.sin(angle) * r
      );
    });
    posAttr.needsUpdate = true;

    // Pulso de opacidad
    linesRef.current.material.opacity = 0.12 + Math.sin(t * 1.5) * 0.06 + (directiveCount * 0.02);
  });

  return (
    <lineSegments ref={linesRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors transparent opacity={0.15} linewidth={1} />
    </lineSegments>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DATA FLOW — Particulas fluyendo por las sinapsis
// ═══════════════════════════════════════════════════════════════════
function DataFlow({ learningActive }) {
  const pointsRef = useRef();
  const PARTICLE_COUNT = 60;

  const { positions, colors, phases } = useMemo(() => {
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    const col = new Float32Array(PARTICLE_COUNT * 3);
    const ph = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const agentIdx = i % 3;
      const agent = AGENT_CONFIG[agentIdx];
      ph[i] = Math.random(); // fase de viaje [0-1]
      // Color del agente
      col[i * 3] = agent.color.r;
      col[i * 3 + 1] = agent.color.g;
      col[i * 3 + 2] = agent.color.b;
    }
    return { positions: pos, colors: col, phases: ph };
  }, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (!pointsRef.current) return;
    const posAttr = pointsRef.current.geometry.attributes.position;
    const speed = learningActive ? 0.4 : 0.15;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const agentIdx = i % 3;
      const agent = AGENT_CONFIG[agentIdx];
      const angle = agent.angle + t * agent.speed;
      const r = agent.radius;

      // Avanzar fase
      phases[i] = (phases[i] + speed * 0.016 + Math.random() * 0.003) % 1;
      const p = phases[i];

      // Interpolar entre centro y posicion del agente
      const toCenter = i % 2 === 0; // mitad van al centro, mitad salen
      const progress = toCenter ? p : 1 - p;

      const endX = Math.cos(angle) * r;
      const endY = Math.sin(t * 0.3 + agentIdx * 2) * 0.3;
      const endZ = Math.sin(angle) * r;

      // Agregar ondulacion perpendicular
      const wave = Math.sin(p * Math.PI * 3 + t * 2) * 0.15;

      posAttr.setXYZ(i,
        endX * progress + wave * Math.sin(angle + Math.PI / 2),
        endY * progress + Math.sin(p * Math.PI) * 0.2,
        endZ * progress + wave * Math.cos(angle + Math.PI / 2)
      );
    }
    posAttr.needsUpdate = true;

    // Opacidad global pulsa
    pointsRef.current.material.opacity = 0.4 + Math.sin(t * 2) * 0.15;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} count={PARTICLE_COUNT} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} count={PARTICLE_COUNT} />
      </bufferGeometry>
      <pointsMaterial
        vertexColors
        transparent
        opacity={0.5}
        size={0.04}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}

// ═══════════════════════════════════════════════════════════════════
// AMBIENT PARTICLES — Fondo neuronal
// ═══════════════════════════════════════════════════════════════════
function AmbientParticles() {
  const pointsRef = useRef();
  const COUNT = 50;

  const positions = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2.5 + Math.random() * 1.5;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
    }
    return pos;
  }, []);

  useFrame(({ clock }) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = clock.getElapsedTime() * 0.02;
      pointsRef.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.01) * 0.05;
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} count={COUNT} />
      </bufferGeometry>
      <pointsMaterial color="#fbbf24" transparent opacity={0.2} size={0.025} sizeAttenuation blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DIRECTIVE RINGS — Anillos que aparecen con directivas activas
// ═══════════════════════════════════════════════════════════════════
function DirectiveRings({ directiveCount }) {
  const ring1Ref = useRef();
  const ring2Ref = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (ring1Ref.current) {
      ring1Ref.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.15) * 0.2;
      ring1Ref.current.rotation.z = t * 0.1;
      ring1Ref.current.material.opacity = directiveCount > 0 ? 0.15 + Math.sin(t * 1.5) * 0.08 : 0.03;
    }
    if (ring2Ref.current) {
      ring2Ref.current.rotation.y = t * 0.08;
      ring2Ref.current.rotation.x = Math.sin(t * 0.12) * 0.15 + Math.PI / 3;
      ring2Ref.current.material.opacity = directiveCount > 2 ? 0.12 + Math.sin(t * 1.2) * 0.06 : 0.02;
    }
  });

  return (
    <group>
      <mesh ref={ring1Ref}>
        <torusGeometry args={[1.7, 0.01, 16, 80]} />
        <meshBasicMaterial color="#10b981" transparent opacity={0.1} />
      </mesh>
      <mesh ref={ring2Ref}>
        <torusGeometry args={[2.0, 0.008, 16, 64]} />
        <meshBasicMaterial color="#8b5cf6" transparent opacity={0.08} />
      </mesh>
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function ZeusOrb({
  learningActive = false,
  directives = [],
  agentStats = {},
  intelligence = 0
}) {
  return (
    <div style={{ width: '100%', height: '300px', position: 'relative' }}>
      <Canvas
        camera={{ position: [0, 0.5, 5.5], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.3} />
        <pointLight position={[4, 3, 5]} intensity={0.6} color="#fbbf24" />
        <pointLight position={[-4, -2, 3]} intensity={0.3} color="#3b82f6" />
        <pointLight position={[0, -3, 2]} intensity={0.2} color="#f97316" />
        <pointLight position={[2, 4, -2]} intensity={0.15} color="#8b5cf6" />

        <ZeusCore learningActive={learningActive} intelligence={intelligence} />
        <AgentNodes agentStats={agentStats} />
        <Synapses agentStats={agentStats} directiveCount={directives.length} />
        <DataFlow learningActive={learningActive} />
        <DirectiveRings directiveCount={directives.length} />
        <AmbientParticles />
      </Canvas>

      {/* Labels overlay */}
      <div style={{
        position: 'absolute', bottom: 8, left: 0, right: 0,
        display: 'flex', justifyContent: 'center', gap: 24,
        fontSize: '0.65rem', color: 'var(--text-muted)', pointerEvents: 'none'
      }}>
        <span style={{ color: '#60a5fa' }}>● Athena</span>
        <span style={{ color: '#fbbf24' }}>● Apollo</span>
        <span style={{ color: '#fb923c' }}>● Prometheus</span>
      </div>
    </div>
  );
}
