import React, { useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import * as THREE from 'three';
import { motion } from 'framer-motion';
import { shaderMaterial } from '@react-three/drei';

// ─── Rain shader material (GPU-driven, zero CPU buffer writes per frame) ───
const RainMaterial = shaderMaterial(
  { uTime: 0 },
  /* vertex */ `
    uniform float uTime;
    attribute float aY0;
    attribute float aXZ;
    void main() {
      vec3 p = position;
      p.y = mod(p.y - uTime * 22.0, 65.0) - 5.0;
      p.x += sin(uTime * 0.3 + aXZ) * 0.4;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = 1.2;
    }
  `,
  /* fragment */ `
    void main() {
      gl_FragColor = vec4(0.55, 0.70, 1.0, 0.38);
    }
  `,
);
extend({ RainMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    rainMaterial: React.ComponentProps<typeof RainMaterial> & { attach?: string };
  }
}

// ─── Camera: smooth dolly toward rooftop ledge then loop ────────────────────
function CameraRig() {
  useFrame((state) => {
    const t = (state.clock.elapsedTime % 60) / 60;
    // Ease in/out cubic
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    state.camera.position.set(
      Math.sin(ease * Math.PI * 0.6) * 3,
      6 - ease * 2.5,
      22 - ease * 38,
    );
    state.camera.lookAt(0, 2, -45);
  });
  return null;
}

// ─── Rain (GPU shader, 8 000 particles) ────────────────────────────────────
function Rain() {
  const matRef = useRef<any>(null);
  const COUNT = 8000;

  const [geometry] = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(COUNT * 3);
    const aY0 = new Float32Array(COUNT);
    const aXZ = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 140;
      pos[i * 3 + 1] = Math.random() * 65;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 140;
      aY0[i] = Math.random() * 65;
      aXZ[i] = Math.random() * Math.PI * 2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aY0',      new THREE.BufferAttribute(aY0, 1));
    geo.setAttribute('aXZ',      new THREE.BufferAttribute(aXZ, 1));
    return [geo];
  }, []);

  useFrame((_, delta) => {
    if (matRef.current) matRef.current.uTime += delta;
  });

  return (
    <points geometry={geometry}>
      <rainMaterial ref={matRef} transparent depthWrite={false} />
    </points>
  );
}

// ─── Skyline: 220 buildings via InstancedMesh ───────────────────────────────
function Skyline() {
  const BUILD_COUNT = 220;

  const { bMatrices, wMatrices, wColors } = useMemo(() => {
    const bMat: THREE.Matrix4[] = [];
    const wMat: THREE.Matrix4[] = [];
    const wCol: THREE.Color[]   = [];
    const dummy = new THREE.Object3D();
    const c     = new THREE.Color();

    const warmTones  = ['#ffe4b0', '#ffd580', '#fff0c0', '#ffeac0'];
    const coolTones  = ['#c0d8ff', '#d0e8ff', '#a8c8ff'];
    const neonTones  = ['#40ffcc', '#ff4488', '#88ffff', '#ffaa00'];

    for (let i = 0; i < BUILD_COUNT; i++) {
      // Ring-based placement for realistic depth
      const ring    = Math.floor(i / 22);
      const angle   = (i % 22) * ((Math.PI * 2) / 22) + ring * 0.4;
      const radius  = 55 + ring * 28 + Math.random() * 18;
      const bx      = Math.cos(angle) * radius + (Math.random() - 0.5) * 20;
      const bz      = -80 + Math.sin(angle) * radius * 0.45 + (Math.random() - 0.5) * 15;

      const bw = 8  + Math.random() * 28;
      const bd = 8  + Math.random() * 28;
      const bh = 25 + Math.random() * 220;

      dummy.position.set(bx, bh / 2, bz);
      dummy.scale.set(bw, bh, bd);
      dummy.updateMatrix();
      bMat.push(dummy.matrix.clone());

      // Windows on front face (facing +Z toward camera)
      const frontZ  = bz + bd / 2 + 0.2;
      const cols     = Math.max(2, Math.floor(bw / 5));
      const rows     = Math.max(2, Math.floor(bh / 6));
      const stepX    = bw / (cols + 1);
      const stepY    = bh / (rows + 1);

      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          if (Math.random() > 0.55) continue; // ~45% lit
          const wx = bx - bw / 2 + stepX * (col + 1);
          const wy = stepY * (r + 1);
          dummy.position.set(wx, wy, frontZ);
          dummy.scale.set(Math.min(stepX * 0.55, 3), Math.min(stepY * 0.6, 3.5), 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          wMat.push(dummy.matrix.clone());

          const rng = Math.random();
          if (rng < 0.06)      c.set(neonTones[Math.floor(Math.random() * neonTones.length)]);
          else if (rng < 0.45) c.set(warmTones[Math.floor(Math.random() * warmTones.length)]);
          else                 c.set(coolTones[Math.floor(Math.random() * coolTones.length)]);
          wCol.push(c.clone());
        }
      }
    }

    return { bMatrices: bMat, wMatrices: wMat, wColors: wCol };
  }, []);

  const buildMeshRef  = useRef<THREE.InstancedMesh>(null);
  const windowMeshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    if (buildMeshRef.current) {
      bMatrices.forEach((m, i) => buildMeshRef.current!.setMatrixAt(i, m));
      buildMeshRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [bMatrices]);

  useEffect(() => {
    if (windowMeshRef.current) {
      wMatrices.forEach((m, i) => {
        windowMeshRef.current!.setMatrixAt(i, m);
        windowMeshRef.current!.setColorAt(i, wColors[i]);
      });
      windowMeshRef.current.instanceMatrix.needsUpdate = true;
      if (windowMeshRef.current.instanceColor) windowMeshRef.current.instanceColor.needsUpdate = true;
    }
  }, [wMatrices, wColors]);

  // Flicker: toggle ~1% of window emissive every 3 seconds (cheap)
  const flickerTimer = useRef(0);
  useFrame((_, delta) => {
    flickerTimer.current += delta;
    if (flickerTimer.current > 3 && windowMeshRef.current?.instanceColor) {
      flickerTimer.current = 0;
      const total = wColors.length;
      const batch = Math.floor(total * 0.01);
      const c2 = new THREE.Color();
      for (let k = 0; k < batch; k++) {
        const idx = Math.floor(Math.random() * total);
        c2.setScalar(Math.random() > 0.5 ? 0 : 1);
        const orig = wColors[idx];
        c2.copy(orig).multiplyScalar(Math.random() > 0.5 ? 0.1 : 1.0);
        windowMeshRef.current.setColorAt(idx, c2);
      }
      windowMeshRef.current.instanceColor!.needsUpdate = true;
    }
  });

  return (
    <group>
      {/* Building shells */}
      <instancedMesh ref={buildMeshRef} args={[undefined, undefined, BUILD_COUNT]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#0b0e14" roughness={0.92} metalness={0.08} />
      </instancedMesh>

      {/* Window grid */}
      {wMatrices.length > 0 && (
        <instancedMesh ref={windowMeshRef} args={[undefined, undefined, wMatrices.length]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      )}
    </group>
  );
}

// ─── Rooftop floor & details ─────────────────────────────────────────────────
function Rooftop() {
  return (
    <group>
      {/* Concrete floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -20]}>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color="#18191d" roughness={0.97} metalness={0.0} />
      </mesh>

      {/* Ledge front */}
      <mesh position={[0, 0.9, 38]}>
        <boxGeometry args={[120, 1.8, 1.2]} />
        <meshStandardMaterial color="#212328" roughness={0.95} />
      </mesh>
      {/* Ledge sides */}
      <mesh position={[-59, 0.9, -20]}>
        <boxGeometry args={[1.2, 1.8, 120]} />
        <meshStandardMaterial color="#212328" roughness={0.95} />
      </mesh>
      <mesh position={[59, 0.9, -20]}>
        <boxGeometry args={[1.2, 1.8, 120]} />
        <meshStandardMaterial color="#212328" roughness={0.95} />
      </mesh>
      {/* Ledge back */}
      <mesh position={[0, 0.9, -79]}>
        <boxGeometry args={[120, 1.8, 1.2]} />
        <meshStandardMaterial color="#212328" roughness={0.95} />
      </mesh>

      {/* Puddles */}
      {[
        [3, 6, 0.4],   [-7, -12, 0.55], [12, -8, 0.3],
        [-14, 15, 0.5], [20, 3, 0.45],  [-3, -28, 0.5],
        [8, -30, 0.35],
      ].map(([px, pz, sc], i) => (
        <mesh key={i} position={[px, 0.02, pz]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[3 * sc + 1.5, 24]} />
          <meshPhysicalMaterial
            roughness={0.01} metalness={0.05} transmission={0.88}
            ior={1.33} transparent opacity={0.92} color="#1a1f2a"
          />
        </mesh>
      ))}

      {/* HVAC unit A */}
      <group position={[-16, 0, -14]}>
        <mesh position={[0, 1.6, 0]}>
          <boxGeometry args={[7, 3.2, 5]} />
          <meshStandardMaterial color="#2e3138" roughness={0.88} metalness={0.35} />
        </mesh>
        <mesh position={[0, 3.22, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[5, 3.5]} />
          <meshStandardMaterial color="#111315" roughness={0.9} />
        </mesh>
        {/* vent grille stripes */}
        {[-1.5, -0.5, 0.5, 1.5].map((dx, i) => (
          <mesh key={i} position={[dx, 1.6, 2.55]}>
            <boxGeometry args={[0.08, 2.6, 0.12]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        ))}
      </group>

      {/* HVAC unit B */}
      <group position={[11, 0, -5]}>
        <mesh position={[0, 1.5, 0]}>
          <boxGeometry args={[5, 3, 4.5]} />
          <meshStandardMaterial color="#2e3138" roughness={0.88} metalness={0.35} />
        </mesh>
        {[-1, 0, 1].map((dx, i) => (
          <mesh key={i} position={[dx, 1.5, 2.28]}>
            <boxGeometry args={[0.07, 2.4, 0.1]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        ))}
      </group>

      {/* HVAC unit C */}
      <group position={[25, 0, -18]}>
        <mesh position={[0, 1.2, 0]}>
          <boxGeometry args={[8, 2.4, 5]} />
          <meshStandardMaterial color="#333840" roughness={0.85} metalness={0.4} />
        </mesh>
        {/* fan circle */}
        <mesh position={[0, 2.42, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.2, 1.6, 24]} />
          <meshStandardMaterial color="#222" side={THREE.DoubleSide} />
        </mesh>
      </group>

      {/* Water tank */}
      <group position={[20, 0, -28]}>
        {/* legs */}
        {[[-2, -2], [2, -2], [-2, 2], [2, 2]].map(([lx, lz], i) => (
          <mesh key={i} position={[lx, 3.5, lz]}>
            <cylinderGeometry args={[0.14, 0.16, 7, 8]} />
            <meshStandardMaterial color="#3a3a3a" metalness={0.5} roughness={0.6} />
          </mesh>
        ))}
        {/* cross braces */}
        {[
          [0, 3.5, 2, Math.PI / 2, 0, 0],
          [0, 3.5, -2, Math.PI / 2, 0, 0],
          [-2, 3.5, 0, 0, 0, Math.PI / 2],
          [2, 3.5, 0, 0, 0, Math.PI / 2],
        ].map(([x, y, z, rx, ry, rz], i) => (
          <mesh key={i} position={[x as number, y as number, z as number]} rotation={[rx as number, ry as number, rz as number]}>
            <cylinderGeometry args={[0.05, 0.05, 4, 6]} />
            <meshStandardMaterial color="#3a3a3a" metalness={0.5} roughness={0.6} />
          </mesh>
        ))}
        {/* tank body */}
        <mesh position={[0, 8, 0]}>
          <cylinderGeometry args={[2.4, 2.6, 5, 18]} />
          <meshStandardMaterial color="#5a4a3a" roughness={0.85} metalness={0.1} />
        </mesh>
        {/* hoops */}
        {[6, 7.5, 9, 10.5].map((y, i) => (
          <mesh key={i} position={[0, y, 0]}>
            <torusGeometry args={[2.55, 0.1, 8, 24]} />
            <meshStandardMaterial color="#2a2018" metalness={0.6} roughness={0.5} />
          </mesh>
        ))}
        {/* conical roof */}
        <mesh position={[0, 11, 0]}>
          <coneGeometry args={[2.8, 1.8, 18]} />
          <meshStandardMaterial color="#2a2018" roughness={0.9} />
        </mesh>
      </group>

      {/* Antenna 1 */}
      <group position={[-26, 0, -32]}>
        <mesh position={[0, 7, 0]}>
          <cylinderGeometry args={[0.28, 0.45, 14, 8]} />
          <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
        </mesh>
        <mesh position={[0, 15.5, 0]}>
          <cylinderGeometry args={[0.05, 0.1, 3, 6]} />
          <meshStandardMaterial color="#888" metalness={0.7} />
        </mesh>
        {/* blinking red light */}
        <mesh position={[0, 17.2, 0]}>
          <sphereGeometry args={[0.28, 8, 8]} />
          <meshBasicMaterial color="#ff2020" toneMapped={false} />
        </mesh>
        {/* cross arms */}
        {[0, Math.PI / 2].map((ry, i) => (
          <mesh key={i} position={[0, 12, 0]} rotation={[0, ry, Math.PI / 2]}>
            <cylinderGeometry args={[0.04, 0.04, 5, 6]} />
            <meshStandardMaterial color="#666" metalness={0.7} />
          </mesh>
        ))}
      </group>

      {/* Antenna 2 (smaller) */}
      <group position={[17, 0, -38]}>
        <mesh position={[0, 5, 0]}>
          <cylinderGeometry args={[0.18, 0.28, 10, 8]} />
          <meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} />
        </mesh>
        <mesh position={[0, 11, 0]}>
          <cylinderGeometry args={[0.03, 0.07, 2.5, 6]} />
          <meshStandardMaterial color="#888" />
        </mesh>
        <mesh position={[0, 12.3, 0]}>
          <sphereGeometry args={[0.2, 6, 6]} />
          <meshBasicMaterial color="#ff4040" toneMapped={false} />
        </mesh>
      </group>

      {/* Billboard */}
      <group position={[-2, 0, -42]}>
        {/* support poles */}
        {[-7.5, 7.5].map((px, i) => (
          <mesh key={i} position={[px, 5, 0]}>
            <cylinderGeometry args={[0.4, 0.5, 10, 8]} />
            <meshStandardMaterial color="#1e2025" metalness={0.5} roughness={0.7} />
          </mesh>
        ))}
        {/* board */}
        <mesh position={[0, 12, 0]}>
          <boxGeometry args={[22, 10, 0.8]} />
          <meshStandardMaterial color="#0d0f12" roughness={0.8} />
        </mesh>
        {/* face – warm neon glow */}
        <mesh position={[0, 12, 0.45]}>
          <planeGeometry args={[21, 9]} />
          <meshBasicMaterial color="#ff6600" toneMapped={false} />
        </mesh>
        {/* reflection light */}
        <pointLight position={[0, 12, 6]} intensity={2.5} color="#ff6600" distance={55} decay={2} />
      </group>

      {/* Second billboard */}
      <group position={[38, 0, -35]}>
        {[-6, 6].map((px, i) => (
          <mesh key={i} position={[px, 4, 0]}>
            <cylinderGeometry args={[0.35, 0.45, 8, 8]} />
            <meshStandardMaterial color="#1e2025" metalness={0.5} roughness={0.7} />
          </mesh>
        ))}
        <mesh position={[0, 10, 0]}>
          <boxGeometry args={[18, 8, 0.7]} />
          <meshStandardMaterial color="#0d0f12" roughness={0.8} />
        </mesh>
        <mesh position={[0, 10, 0.38]}>
          <planeGeometry args={[17, 7]} />
          <meshBasicMaterial color="#00ccff" toneMapped={false} />
        </mesh>
        <pointLight position={[0, 10, 5]} intensity={2} color="#00ccff" distance={45} decay={2} />
      </group>

      {/* Fire escape platform + ladder rungs */}
      <group position={[45, 0, -22]}>
        {[2, 8].map((py, i) => (
          <mesh key={i} position={[0, py, 0]}>
            <boxGeometry args={[4, 0.18, 5.5]} />
            <meshStandardMaterial color="#141618" roughness={0.9} metalness={0.3} />
          </mesh>
        ))}
        {/* vertical rails */}
        {[-1.8, 1.8].map((rx, i) => (
          <mesh key={i} position={[rx, 5.1, 2.5]} rotation={[0.18, 0, 0]}>
            <boxGeometry args={[0.1, 7, 0.1]} />
            <meshStandardMaterial color="#1e2025" />
          </mesh>
        ))}
        {/* rungs */}
        {[0, 1, 2, 3, 4, 5].map((ri, i) => (
          <mesh key={i} position={[0, 2.8 + ri, 2.5]} rotation={[0.18, 0, 0]}>
            <boxGeometry args={[3.6, 0.07, 0.5]} />
            <meshStandardMaterial color="#111" />
          </mesh>
        ))}
      </group>

      {/* Skylight / rooftop access hatch */}
      <group position={[-30, 0, -10]}>
        <mesh position={[0, 0.4, 0]}>
          <boxGeometry args={[4, 0.8, 3]} />
          <meshStandardMaterial color="#232528" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.81, 0]} rotation={[-0.4, 0, 0]}>
          <boxGeometry args={[3.6, 0.1, 2.8]} />
          <meshStandardMaterial color="#1a1c20" roughness={0.5} metalness={0.3} />
        </mesh>
      </group>

      {/* Scattered debris / small details */}
      {[
        [5, -6],   [-9, -20],  [14, 22],
        [-20, 8],  [32, -15],  [-8, 30],
      ].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, 0.15, dz]} rotation={[0, Math.random() * Math.PI, 0]}>
          <boxGeometry args={[0.4 + Math.random() * 0.6, 0.3, 0.3 + Math.random() * 0.5]} />
          <meshStandardMaterial color="#1a1c20" roughness={0.97} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Scene root ───────────────────────────────────────────────────────────────
export function RooftopScene() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.5, ease: 'easeInOut' }}
      className="absolute inset-0"
    >
      <Canvas
        gl={{
          antialias: false,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
        camera={{ fov: 55, near: 0.5, far: 800 }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={['#03050a']} />
        <fogExp2 attach="fog" args={['#03050a', 0.012]} />

        {/* Moonlight */}
        <ambientLight intensity={0.18} color="#3355aa" />
        <directionalLight
          position={[60, 80, 30]}
          intensity={0.55}
          color="#99bbee"
        />
        {/* Warm ground bounce */}
        <directionalLight position={[0, -10, 0]} intensity={0.08} color="#221100" />

        <CameraRig />
        <Rooftop />
        <Skyline />
        <Rain />
      </Canvas>
    </motion.div>
  );
}
