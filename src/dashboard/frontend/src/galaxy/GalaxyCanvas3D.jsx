import React, { useRef, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial, Html, Stars, Line } from '@react-three/drei';
import * as THREE from 'three';
import { AGENTS, ZEUS, AGENT_HEX, AGENT_KPIS } from './agents';

const RING_R = 3.3;
function ringXY(angleDeg, r = RING_R) {
  const a = (angleDeg * Math.PI) / 180; // 0 = arriba
  return [r * Math.sin(a), r * Math.cos(a), 0];
}
function fmtKpi(val, kpi) {
  if (val == null) return '—';
  if (kpi.money) return `$${Number(val).toLocaleString()}`;
  return `${val}${kpi.suffix || ''}`;
}

function OrbLabel({ agent, data, color, zeus }) {
  const kpis = zeus ? [] : (AGENT_KPIS[agent.id] || []).slice(0, 2);
  const status = data?.status || 'active';
  return (
    <div style={{ pointerEvents: 'none', textAlign: 'center', width: 140, transform: 'translateY(6px)', userSelect: 'none' }}>
      <div style={{ fontSize: zeus ? '1rem' : '0.82rem', fontWeight: zeus ? 800 : 700, color: '#fff', letterSpacing: zeus ? '0.06em' : '0.03em', textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>{agent.label.toUpperCase()}</div>
      <div style={{ fontSize: '0.6rem', color: zeus ? '#93c5fd' : 'var(--text-tertiary)', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>{agent.role}</div>
      {!zeus && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 2 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: status === 'active' ? '#10b981' : '#6b7280', boxShadow: status === 'active' ? '0 0 6px #10b981' : 'none' }} />
            <span style={{ fontSize: '0.55rem', color: status === 'active' ? '#34d399' : '#9ca3af' }}>Activo</span>
          </div>
          {kpis.length > 0 && (
            <div style={{ marginTop: 3, display: 'flex', gap: 8, justifyContent: 'center' }}>
              {kpis.map(k => (
                <div key={k.key} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color, fontFamily: 'JetBrains Mono, monospace', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>{fmtKpi((data?.kpis && data.kpis[k.key]) ?? data?.[k.key], k)}</div>
                  <div style={{ fontSize: '0.46rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k.label}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Orb({ agent, data, selected, onSelect, zeus }) {
  const grp = useRef(), glow = useRef();
  const color = zeus ? AGENT_HEX.zeus : AGENT_HEX[agent.id];
  const [x, y] = zeus ? [0, 0, 0] : ringXY(agent.angle);
  const baseR = zeus ? 0.95 : 0.5;
  const r = selected ? baseR * 1.18 : baseR;
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (grp.current && !zeus) grp.current.position.z = Math.sin(t * 0.5 + agent.angle) * 0.2;
    if (glow.current) glow.current.material.opacity = 0.06 + Math.sin(t * 0.9 + (zeus ? 0 : agent.angle)) * 0.02;
  });
  return (
    <group position={[x, y, 0]}>
      <group ref={grp}>
        <Sphere ref={glow} args={[r * (zeus ? 1.8 : 2), 24, 24]}>
          <meshBasicMaterial color={color} transparent opacity={0.07} side={THREE.BackSide} />
        </Sphere>
        <Sphere args={[r, 48, 48]}
          onClick={(e) => { e.stopPropagation(); onSelect(zeus ? 'zeus' : agent.id); }}
          onPointerOver={() => (document.body.style.cursor = 'pointer')}
          onPointerOut={() => (document.body.style.cursor = 'default')}>
          <MeshDistortMaterial color={color} emissive={color} emissiveIntensity={selected ? 0.95 : 0.6} metalness={0.55} roughness={0.25} distort={zeus ? 0.24 : 0.16} speed={zeus ? 1.6 : 1.3} />
        </Sphere>
        <Html position={[0, -r - 0.45, 0]} center distanceFactor={9} style={{ pointerEvents: 'none' }}>
          <OrbLabel agent={zeus ? ZEUS : agent} data={data} color={color} zeus={zeus} />
        </Html>
      </group>
    </group>
  );
}

export default function GalaxyCanvas3D({ agentsData = {}, selected, onSelect }) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* nebulosa CSS detrás del canvas */}
      <div className="galaxy-nebula" style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 45%, rgba(59,130,246,0.12), transparent 55%), radial-gradient(ellipse at 70% 75%, rgba(168,85,247,0.07), transparent 50%), radial-gradient(ellipse at 25% 70%, rgba(16,185,129,0.05), transparent 50%)', pointerEvents: 'none' }} />
      <Canvas camera={{ position: [0, 0, 9.5], fov: 50 }} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }} dpr={[1, 1.5]} style={{ background: 'transparent' }}>
        <ambientLight intensity={0.65} />
        <pointLight position={[0, 0, 4]} intensity={1.3} color="#88aaff" />
        <pointLight position={[6, 4, 3]} intensity={0.4} color="#ffffff" />
        <Suspense fallback={null}>
          <Stars radius={90} depth={60} count={2200} factor={4} saturation={0.7} fade speed={0.4} />
          {/* conexiones */}
          {AGENTS.map(a => (
            <Line key={a.id} points={[[0, 0, 0], ringXY(a.angle)]} color={AGENT_HEX[a.id]} lineWidth={selected === a.id ? 1.6 : 0.7} transparent opacity={selected === a.id ? 0.6 : 0.22} dashed={a.awareness} dashScale={3} />
          ))}
          <Orb zeus agent={ZEUS} data={agentsData.zeus} selected={selected === 'zeus'} onSelect={onSelect} />
          {AGENTS.map(a => (
            <Orb key={a.id} agent={a} data={agentsData[a.id]} selected={selected === a.id} onSelect={onSelect} />
          ))}
        </Suspense>
      </Canvas>
    </div>
  );
}
