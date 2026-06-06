import React, { useRef, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';

// Campo de estrellas 3D que rota lento — profundidad cósmica detrás de los orbes.
// Render barato (un solo Stars de drei). pointerEvents none: no interfiere con los orbes.
function SpinningStars() {
  const ref = useRef();
  useFrame((_, delta) => {
    if (ref.current) {
      ref.current.rotation.y += delta * 0.012;
      ref.current.rotation.x += delta * 0.005;
    }
  });
  return (
    <group ref={ref}>
      <Stars radius={90} depth={60} count={2600} factor={4} saturation={0.7} fade speed={0.5} />
    </group>
  );
}

export default function StarField() {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
      <Canvas camera={{ position: [0, 0, 1], fov: 60 }} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }} style={{ background: 'transparent' }} dpr={[1, 1.5]}>
        <Suspense fallback={null}>
          <SpinningStars />
        </Suspense>
      </Canvas>
    </div>
  );
}
