import { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Stars } from '@react-three/drei';
import * as THREE from 'three';
import api from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// DNA PARTICLE — cada DNA es una esfera en espacio 3D
// ═══════════════════════════════════════════════════════════════════════════

function DNAParticle({ dna, position, color, onHover, onUnhover, onClick }) {
  const mesh = useRef();
  const [hovered, setHovered] = useState(false);
  const size = Math.max(0.2, Math.min(1.2, 0.2 + Math.log(dna.fitness?.tests_total + 1) * 0.25));

  useFrame((_state, delta) => {
    if (mesh.current) {
      if (hovered) {
        mesh.current.scale.lerp(new THREE.Vector3(1.3, 1.3, 1.3), 0.1);
      } else {
        mesh.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
      }
      mesh.current.rotation.y += delta * 0.15;
    }
  });

  return (
    <mesh
      ref={mesh}
      position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); onHover(dna); }}
      onPointerOut={() => { setHovered(false); onUnhover(); }}
      onClick={(e) => { e.stopPropagation(); onClick && onClick(dna); }}
    >
      <sphereGeometry args={[size, 24, 24]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={hovered ? 0.8 : 0.3}
        metalness={0.2}
        roughness={0.3}
      />
    </mesh>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LINEAGE LINE — conecta parent → child
// ═══════════════════════════════════════════════════════════════════════════

function LineageLine({ from, to, color = '#8b5cf6' }) {
  const points = useMemo(() => [
    new THREE.Vector3(...from),
    new THREE.Vector3(...to)
  ], [from, to]);

  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} opacity={0.4} transparent linewidth={1} />
    </line>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT → COLOR MAP
// ═══════════════════════════════════════════════════════════════════════════

const PRODUCT_COLORS = {
  'hot pickled tomatoes': '#ef4444',
  'hot_pickled_tomatoes': '#ef4444',
  'build your box': '#ec4899',
  'build_your_box': '#ec4899',
  'byb': '#ec4899',
  'half sour': '#10b981',
  'half_sour': '#10b981',
  'texas sweet chili': '#f59e0b',
  'texas_sweet_chili': '#f59e0b'
};

function productColor(product) {
  const key = (product || '').toLowerCase();
  for (const [k, v] of Object.entries(PRODUCT_COLORS)) {
    if (key.includes(k)) return v;
  }
  return '#6b7280'; // unknown
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCENE
// ═══════════════════════════════════════════════════════════════════════════

function GenomeScene({ dnas, onHover, onUnhover, onDnaClick }) {
  // Position DNAs in 3D space
  //   X: ROAS (0 = left, 10 = right)
  //   Y: sample count (log scale, 0 = bottom, max = top)
  //   Z: recency (older = back, recent = forward)

  const positions = useMemo(() => {
    if (dnas.length === 0) return [];

    const maxSamples = Math.max(...dnas.map(d => d.fitness?.tests_total || 0), 1);
    const now = Date.now();

    return dnas.map(d => {
      const roas = Math.min(10, d.fitness?.avg_roas || 0);
      const x = (roas / 10 * 20) - 10; // -10 to 10

      const samples = Math.log(Math.max(1, d.fitness?.tests_total || 1)) / Math.log(Math.max(2, maxSamples));
      const y = samples * 12 - 4; // -4 to 8

      let z = 0;
      if (d.fitness?.last_test_at) {
        const ageDays = (now - new Date(d.fitness.last_test_at).getTime()) / 86400000;
        z = -Math.min(15, ageDays * 0.3); // newer = toward camera
      } else {
        z = -10;
      }

      return { dna: d, pos: [x, y, z] };
    });
  }, [dnas]);

  // Lineage edges — parent-child relationships
  const lineageEdges = useMemo(() => {
    const edges = [];
    const posMap = {};
    positions.forEach(p => { posMap[p.dna.dna_hash] = p.pos; });

    dnas.forEach(d => {
      if (d.parent_dnas && d.parent_dnas.length > 0) {
        d.parent_dnas.forEach(pHash => {
          if (posMap[pHash] && posMap[d.dna_hash]) {
            edges.push({
              from: posMap[pHash],
              to: posMap[d.dna_hash],
              color: d.created_via === 'mutation' ? '#f59e0b' : d.created_via === 'crossover' ? '#8b5cf6' : '#3b82f6'
            });
          }
        });
      }
    });
    return edges;
  }, [positions, dnas]);

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 10]} intensity={0.8} color="#3b82f6" />
      <pointLight position={[-10, -5, 10]} intensity={0.4} color="#ec4899" />
      <Stars radius={100} depth={50} count={2000} factor={3} saturation={0} fade speed={0.5} />

      {/* Axis labels */}
      <Text position={[11, 0, 0]} fontSize={0.6} color="#3b82f6" anchorX="left">
        ROAS →
      </Text>
      <Text position={[0, 9, 0]} fontSize={0.6} color="#10b981" anchorX="center">
        ↑ Samples
      </Text>
      <Text position={[0, 0, 1]} fontSize={0.5} color="#ec4899" anchorX="center">
        Recent ●
      </Text>

      {/* Origin cross lines */}
      <gridHelper args={[30, 30, '#1a2047', '#0e1230']} rotation={[Math.PI / 2, 0, 0]} position={[0, -4, 0]} />

      {/* Lineage edges */}
      {lineageEdges.map((e, i) => (
        <LineageLine key={i} from={e.from} to={e.to} color={e.color} />
      ))}

      {/* DNA particles */}
      {positions.map((p, i) => (
        <DNAParticle
          key={p.dna.dna_hash || i}
          dna={p.dna}
          position={p.pos}
          color={productColor(p.dna.dimensions?.product)}
          onHover={onHover}
          onUnhover={onUnhover}
          onClick={onDnaClick}
        />
      ))}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

export default function DNAGenomeSpace() {
  const [data, setData] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const res = await api.get('/api/creative-agent/dna?limit=200&min_samples=1');
      setData(res.data);
    } catch (err) {
      console.error('DNAGenomeSpace error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !data) {
    return <div className="bos-loading">Cargando genoma creativo...</div>;
  }

  if (!data || !data.dnas) {
    return <div className="bos-loading">Sin datos DNA aún</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--bos-text)' }}>
            🧬 Genome Space
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--bos-text-muted)' }}>
            {data.dnas.length} DNAs · {data.global_stats?.total_tests || 0} tests · {data.global_stats?.overall_win_rate ? Math.round(data.global_stats.overall_win_rate * 100) : 0}% win rate
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: '0.62rem', color: 'var(--bos-text-muted)' }}>
          {Object.entries(PRODUCT_COLORS).slice(0, 4).map(([name, color]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: 5, background: color }} />
              {name.split('_').join(' ').split(' ')[0]}
            </div>
          ))}
        </div>
      </div>

      <div className="genome-canvas">
        <Canvas camera={{ position: [0, 0, 20], fov: 55 }}>
          <GenomeScene
            dnas={data.dnas}
            onHover={setHovered}
            onUnhover={() => setHovered(null)}
          />
          <OrbitControls
            enableDamping
            dampingFactor={0.08}
            enableZoom
            enablePan
            autoRotate
            autoRotateSpeed={0.4}
          />
        </Canvas>

        {hovered && (
          <div className="genome-tooltip" style={{ top: 20, right: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--bos-electric)' }}>
              {hovered.dna_hash?.substring(0, 40)}...
            </div>
            {['style', 'copy_angle', 'scene', 'product', 'hook_type'].map(dim => (
              <div key={dim} style={{ fontSize: '0.65rem', color: 'var(--bos-text-muted)' }}>
                <strong style={{ color: 'var(--bos-text)' }}>{dim}:</strong> {hovered.dimensions?.[dim] || '?'}
              </div>
            ))}
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(139, 92, 246, 0.3)' }}>
              <div>ROAS: <strong style={{ color: 'var(--bos-bio)' }}>{hovered.fitness?.avg_roas}x</strong></div>
              <div>Tests: {hovered.fitness?.tests_total} ({hovered.fitness?.tests_graduated} graduated)</div>
              <div>Confidence: {Math.round((hovered.fitness?.sample_confidence || 0) * 100)}%</div>
              {hovered.generation > 0 && (
                <div>Gen {hovered.generation} · {hovered.created_via}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
