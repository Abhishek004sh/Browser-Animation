import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9 — Environment Storytelling & Rooftop Realism
//
// This file is purely additive: it only adds clutter, wear, and small ambient
// life to the existing rooftop. Nothing here reads or mutates camera, weather
// (W), post-processing, lighting, or character state — every component below
// tracks its own local time via useFrame and is safe to mount alongside the
// existing systems without altering their behavior.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Small helpers ────────────────────────────────────────────────────────────

// Deterministic pseudo-random in [0,1) from an integer seed — keeps generated
// layouts stable across re-renders without needing React state.
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Irregular blob outline (flat in XY) — used for puddles so they read as
// naturally pooled water rather than perfect circles.
function makeBlobGeometry(radius: number, seed: number, segments = 22, irregularity = 0.32) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const n = Math.sin(a * 3.1 + seed * 7.7) * 0.5 + Math.sin(a * 5.3 + seed * 2.1) * 0.3;
    const r = radius * (1 + n * irregularity);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 1);
}

// Small canvas-drawn label/decal texture — reused for stencilled warning
// signs, maintenance markings, and numbered equipment labels.
function makeDecalTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w = 256,
  h = 128,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ─── Rooftop wear — moss, stains, rust, dirt, cracks, surface variation ──────
// A thin transparent overlay laid just above the existing concrete floor.
// Reuses the same hash/noise shader idiom as the existing WaterFlow film so
// no new material technique is introduced. Static-per-frame-cost-cheap: the
// only per-frame work is a single uniform write.
function RooftopWear() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i),              hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
        return v;
      }
      void main() {
        // Corner distance drives moss growth — damp, sheltered corners collect it
        vec2 corner = vec2(58.0, 78.0);
        float cornerDist = min(
          min(length(vUv * vec2(118.0,118.0) - vec2(0.0,0.0)), length(vUv*vec2(118.0,118.0) - vec2(118.0,0.0))),
          min(length(vUv * vec2(118.0,118.0) - vec2(0.0,118.0)), length(vUv*vec2(118.0,118.0) - vec2(118.0,118.0)))
        );
        float moss = fbm(vWorldPos.xz * 0.18 + 4.1) * smoothstep(38.0, 4.0, cornerDist);

        // General grime — coarse low-frequency dirt patches
        float dirt = fbm(vWorldPos.xz * 0.05) * 0.65 + fbm(vWorldPos.xz * 0.22 + 9.0) * 0.35;

        // Fine cracks — thin dark noise-driven lines
        float crackN = fbm(vWorldPos.xz * 0.6 + 2.0);
        float crack  = smoothstep(0.485, 0.5, crackN) * (1.0 - smoothstep(0.5, 0.515, crackN));

        // Rust streaks near metal bases — vertical-biased noise
        float rustN  = fbm(vec2(vWorldPos.x * 0.9, vWorldPos.z * 0.06) + 12.0);
        float rust   = smoothstep(0.62, 0.94, rustN) * smoothstep(0.0, 0.35, dirt);

        vec3 dirtCol  = vec3(0.10, 0.095, 0.085);
        vec3 mossCol  = vec3(0.06, 0.14, 0.07);
        vec3 rustCol  = vec3(0.28, 0.13, 0.05);
        vec3 crackCol = vec3(0.0, 0.0, 0.0);

        vec3 col   = dirtCol * dirt * 0.55 + mossCol * moss * 0.85 + rustCol * rust * 0.55;
        float alpha = clamp(dirt * 0.30 + moss * 0.55 + rust * 0.45 + crack * 0.5, 0.0, 0.82);
        col = mix(col, crackCol, crack * 0.6);
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });

  return (
    <mesh position={[0, 0.012, -20]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
      <planeGeometry args={[118, 118]} />
    </mesh>
  );
}

// ─── Rooftop clutter — conduits, junction boxes, pipes, trays, vents, panels,
//     drain covers, placed in the gaps between existing equipment ────────────
function RooftopClutter() {
  const groupRef = useRef<THREE.Group>(null);

  // Slow turbine-vent rotation — purely decorative, negligible per-frame cost.
  const vent1 = useRef<THREE.Mesh>(null);
  const vent2 = useRef<THREE.Mesh>(null);
  const vent3 = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (vent1.current) vent1.current.rotation.y += dt * 0.5;
    if (vent2.current) vent2.current.rotation.y += dt * 0.35;
    if (vent3.current) vent3.current.rotation.y += dt * 0.42;
  });

  const metalDark  = <meshStandardMaterial color="#2e3138" roughness={0.85} metalness={0.4} />;
  const metalMid   = <meshStandardMaterial color="#3a3a3a" roughness={0.6} metalness={0.5} />;
  const panelPaint = <meshStandardMaterial color="#3a4a3a" roughness={0.75} metalness={0.15} />;
  const rustyPipe  = <meshStandardMaterial color="#4a3a2e" roughness={0.8} metalness={0.35} />;

  return (
    <group ref={groupRef}>
      {/* Conduit run along the inboard side of the south ledge */}
      <group position={[0, 0, 33]}>
        <mesh position={[-40, 0.5, 0]} rotation={[0,0,Math.PI/2]} castShadow><cylinderGeometry args={[0.09,0.09,36,6]} /><meshStandardMaterial color="#232528" roughness={0.7} metalness={0.4} /></mesh>
        {[-52,-32,-12,8,28,48].map((x,i)=>(
          <mesh key={i} position={[x,0.5,0]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[0.11,0.11,0.3,6]} /><meshStandardMaterial color="#1c1e21" metalness={0.5} roughness={0.6} /></mesh>
        ))}
      </group>

      {/* Junction boxes scattered near equipment, not blocking pathways */}
      {([[34,10,0],[-42,5,0.3],[-46,-45,0.15],[42,-50,0.4],[6,-55,0.2]] as [number,number,number][]).map(([x,z,rot],i)=>(
        <group key={i} position={[x,0,z]} rotation={[0,rot,0]}>
          <mesh position={[0,0.55,0]} castShadow><boxGeometry args={[0.6,0.5,0.4]} />{metalDark}</mesh>
          <mesh position={[0,0.42,0.21]}><planeGeometry args={[0.36,0.24]} /><meshStandardMaterial color="#151719" roughness={0.4} metalness={0.6} /></mesh>
        </group>
      ))}

      {/* Pipe runs with elbows, feeding from HVAC units toward the nearest vent */}
      <group position={[-16, 0, -9]}>
        <mesh position={[0,0.9,0]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[0.13,0.13,3.4,8]} />{rustyPipe}</mesh>
        <mesh position={[1.7,1.6,0]}><sphereGeometry args={[0.15,8,8]} />{rustyPipe}</mesh>
        <mesh position={[1.7,1.6,0]} rotation={[Math.PI/2,0,0]}><cylinderGeometry args={[0.13,0.13,2.2,8]} />{rustyPipe}</mesh>
      </group>
      <group position={[25, 0, -13]}>
        <mesh position={[0,0.7,0]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[0.11,0.11,2.6,8]} />{metalMid}</mesh>
      </group>

      {/* Cable tray — perforated-look run between water tank and fire escape */}
      <group position={[32, 1.35, -25]} rotation={[0, 0.35, 0]}>
        <mesh castShadow><boxGeometry args={[16, 0.12, 0.9]} /><meshStandardMaterial color="#232528" roughness={0.75} metalness={0.5} /></mesh>
        {Array.from({length: 10}).map((_,i)=>(
          <mesh key={i} position={[-7+i*1.55,0.07,0]}><boxGeometry args={[0.08,0.05,0.86]} /><meshStandardMaterial color="#111214" /></mesh>
        ))}
        {[-6,-1,4,8.5].map((x,i)=><mesh key={i} position={[x,0,0]}><boxGeometry args={[0.12,0.55,0.12]} /><meshStandardMaterial color="#1a1c1f" metalness={0.4} roughness={0.7} /></mesh>)}
      </group>

      {/* Turbine roof vents */}
      <group position={[5, 0, -55]}>
        <mesh position={[0,1.0,0]}><cylinderGeometry args={[0.5,0.55,2.0,10]} />{metalDark}</mesh>
        <mesh ref={vent1} position={[0,2.15,0]}>
          <group>
            {[0,1,2,3].map(i=>(
              <mesh key={i} rotation={[0,i*Math.PI/2,0]} position={[0.28,0,0]}><boxGeometry args={[0.5,0.02,0.34]} /><meshStandardMaterial color="#4a4a4a" metalness={0.6} roughness={0.4} /></mesh>
            ))}
          </group>
        </mesh>
      </group>
      <group position={[-45, 0, -60]}>
        <mesh position={[0,0.7,0]}><cylinderGeometry args={[0.36,0.4,1.4,10]} />{metalDark}</mesh>
        <mesh ref={vent2} position={[0,1.5,0]}>
          <group>
            {[0,1,2,3].map(i=>(
              <mesh key={i} rotation={[0,i*Math.PI/2,0]} position={[0.2,0,0]}><boxGeometry args={[0.36,0.02,0.24]} /><meshStandardMaterial color="#4a4a4a" metalness={0.6} roughness={0.4} /></mesh>
            ))}
          </group>
        </mesh>
      </group>
      <group position={[48, 0, 10]}>
        <mesh position={[0,0.8,0]}><cylinderGeometry args={[0.4,0.45,1.6,10]} />{metalDark}</mesh>
        <mesh ref={vent3} position={[0,1.72,0]}>
          <group>
            {[0,1,2,3].map(i=>(
              <mesh key={i} rotation={[0,i*Math.PI/2,0]} position={[0.22,0,0]}><boxGeometry args={[0.4,0.02,0.27]} /><meshStandardMaterial color="#4a4a4a" metalness={0.6} roughness={0.4} /></mesh>
            ))}
          </group>
        </mesh>
      </group>

      {/* Utility panels — small painted electrical cabinets */}
      <group position={[-50, 0, -5]} rotation={[0, Math.PI / 2, 0]}>
        <mesh position={[0,0.9,0]} castShadow><boxGeometry args={[1.3,1.8,0.5]} />{panelPaint}</mesh>
        <mesh position={[0,0.9,0.26]}><planeGeometry args={[1.0,1.4]} /><meshStandardMaterial color="#2c3a2c" roughness={0.7} /></mesh>
        <mesh position={[0,1.5,0.27]}><boxGeometry args={[0.5,0.12,0.02]} /><meshStandardMaterial color="#c9c060" roughness={0.5} /></mesh>
      </group>
      <group position={[50, 0, -40]} rotation={[0, -0.4, 0]}>
        <mesh position={[0,0.85,0]} castShadow><boxGeometry args={[1.1,1.6,0.45]} />{panelPaint}</mesh>
        <mesh position={[0,0.85,0.24]}><planeGeometry args={[0.85,1.2]} /><meshStandardMaterial color="#2c3a2c" roughness={0.7} /></mesh>
      </group>

      {/* Drain covers — sunk grates where low-lying water collects */}
      {([[6,0.03,12],[-15,0.03,20],[9,0.03,-33],[-4,0.03,-30]] as [number,number,number][]).map(([x,y,z],i)=>(
        <group key={i} position={[x,y,z]}>
          <mesh rotation={[-Math.PI/2,0,0]}><circleGeometry args={[0.9,16]} /><meshStandardMaterial color="#0e0f11" roughness={0.55} metalness={0.55} /></mesh>
          {Array.from({length:6}).map((_,j)=>(
            <mesh key={j} position={[0,0.005,0]} rotation={[-Math.PI/2,0,(j/6)*Math.PI]}><planeGeometry args={[1.7,0.06]} /><meshStandardMaterial color="#050607" metalness={0.6} roughness={0.5} /></mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

// ─── Safety railings — instanced posts along two roof edges ─────────────────
function SafetyRailings() {
  const postRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // Edge A: along part of the south ledge (leaves room for the fire escape).
  // Edge B: along part of the west side ledge.
  const posts = useMemo(() => {
    const pts: [number, number, number][] = [];
    for (let x = -55; x <= 15; x += 3.2) pts.push([x, 1.05, 34.4]);
    for (let z = -70; z <= -25; z += 3.2) pts.push([-57.4, 1.05, z]);
    return pts;
  }, []);

  useFrame(() => {
    if (!postRef.current) return;
    posts.forEach((p, i) => {
      dummy.position.set(p[0], p[1], p[2]);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      postRef.current!.setMatrixAt(i, dummy.matrix);
    });
    postRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={postRef} args={[undefined, undefined, posts.length]} castShadow>
        <cylinderGeometry args={[0.045, 0.045, 1.05, 6]} />
        <meshStandardMaterial color="#3d4148" roughness={0.55} metalness={0.6} />
      </instancedMesh>
      {/* Top rails */}
      <mesh position={[-20, 1.55, 34.4]}><boxGeometry args={[70, 0.06, 0.06]} /><meshStandardMaterial color="#3d4148" roughness={0.5} metalness={0.6} /></mesh>
      <mesh position={[-57.4, 1.55, -47.5]} rotation={[0, Math.PI / 2, 0]}><boxGeometry args={[45, 0.06, 0.06]} /><meshStandardMaterial color="#3d4148" roughness={0.5} metalness={0.6} /></mesh>
      <mesh position={[-20, 1.3, 34.4]}><boxGeometry args={[70, 0.05, 0.05]} /><meshStandardMaterial color="#3d4148" roughness={0.5} metalness={0.6} /></mesh>
      <mesh position={[-57.4, 1.3, -47.5]} rotation={[0, Math.PI / 2, 0]}><boxGeometry args={[45, 0.05, 0.05]} /><meshStandardMaterial color="#3d4148" roughness={0.5} metalness={0.6} /></mesh>
    </group>
  );
}

// ─── Maintenance ladder — rails + instanced rungs up to the roof hatch ───────
function MaintenanceLadder() {
  const rungRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const RUNGS = 9;

  useFrame(() => {
    if (!rungRef.current) return;
    for (let i = 0; i < RUNGS; i++) {
      dummy.position.set(0, 0.3 + i * 0.32, 0);
      dummy.rotation.set(Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      rungRef.current.setMatrixAt(i, dummy.matrix);
    }
    rungRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group position={[-32.4, 0, -10]} rotation={[0, Math.PI / 2, 0]}>
      {[-0.28, 0.28].map((x, i) => (
        <mesh key={i} position={[x, 1.6, 0]} castShadow><cylinderGeometry args={[0.03, 0.03, 3.2, 6]} /><meshStandardMaterial color="#4a4d52" roughness={0.5} metalness={0.65} /></mesh>
      ))}
      <instancedMesh ref={rungRef} args={[undefined, undefined, RUNGS]}>
        <cylinderGeometry args={[0.025, 0.025, 0.62, 6]} />
        <meshStandardMaterial color="#4a4d52" roughness={0.5} metalness={0.65} />
      </instancedMesh>
    </group>
  );
}

// ─── Extra puddles — irregular, varied-size, additive to the existing ones ──
function ExtraPuddles() {
  const mat = useMemo(() => new THREE.MeshPhysicalMaterial({
    roughness: 0.01, metalness: 0.05, transmission: 0.88, ior: 1.33,
    transparent: true, opacity: 0.9, color: '#1a1f2a',
  }), []);

  // [x, z, radius, seed]
  const PUDDLES: [number, number, number, number][] = [
    [6, 12, 1.6, 1.3], [-15, 20, 2.1, 4.7], [9, -33, 1.3, 2.2],
    [-4, -30, 1.9, 6.1], [-24, -3, 1.1, 8.4], [16, -18, 0.9, 3.6],
    [-38, -30, 1.4, 5.5], [30, -6, 1.0, 9.2],
  ];

  const geos = useMemo(
    () => PUDDLES.map(([, , r, seed]) => makeBlobGeometry(r, seed)),
    [],
  );

  return (
    <group>
      {PUDDLES.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.025, z]} rotation={[-Math.PI / 2, 0, 0]} geometry={geos[i]} material={mat} />
      ))}
    </group>
  );
}

// ─── Gentle water flow toward drain covers ───────────────────────────────────
function DrainFlowStreaks() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i),              hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
      }
      void main() {
        // Flow travels along +v (streak's local length axis) toward the drain
        float streak = noise(vec2(vUv.x * 5.0, vUv.y * 3.0 - uTime * 0.32));
        float edge   = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        float fade   = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
        float alpha  = streak * edge * fade * 0.34;
        if (alpha < 0.006) discard;
        vec3 col = vec3(0.42, 0.52, 0.62);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });

  // [fromX, fromZ, toX, toZ]
  const RUNS: [number, number, number, number][] = [
    [4, 8, 6, 12], [-13, 16, -15, 20], [10, -28, 9, -33], [-5, -25, -4, -30],
  ];

  return (
    <group>
      {RUNS.map(([fx, fz, tx, tz], i) => {
        const dx = tx - fx, dz = tz - fz;
        const len = Math.max(0.6, Math.hypot(dx, dz) + 1.2);
        const angle = Math.atan2(dz, dx);
        const midX = (fx + tx) / 2, midZ = (fz + tz) / 2;
        return (
          <mesh key={i} position={[midX, 0.028, midZ]} rotation={[-Math.PI / 2, 0, -angle]} material={mat}>
            <planeGeometry args={[len, 0.7]} />
          </mesh>
        );
      })}
    </group>
  );
}

// ─── Occasional droplets from pipes, ledges & equipment ─────────────────────
function EquipmentDrips() {
  const EMITTERS: [number, number, number][] = [
    [-16, 1.75, -9], [25, 1.3, -13], [32, 1.5, -25], [-50, 1.75, -5], [50, 1.6, -40],
  ];
  const PER = 10;
  const COUNT = EMITTERS.length * PER;

  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aX; attribute float aY; attribute float aZ;
      attribute float aPhase; attribute float aSpeed;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        float t   = fract(aPhase + uTime * aSpeed);
        float y   = aY - t * aY;
        vec4 mvPos  = modelViewMatrix * vec4(aX, y, aZ, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float dist  = max(1.0, -mvPos.z);
        gl_PointSize = clamp(40.0 / dist, 0.4, 2.6);
        vAlpha = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.8, 1.0, t)) * 0.55;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float alpha = (1.0 - smoothstep(0.05, 0.5, r)) * vAlpha;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(0.62, 0.78, 0.94, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const aX = new Float32Array(COUNT), aY = new Float32Array(COUNT), aZ = new Float32Array(COUNT);
    const aPhase = new Float32Array(COUNT), aSpeed = new Float32Array(COUNT);
    const pos = new Float32Array(COUNT * 3);
    let idx = 0;
    EMITTERS.forEach(([ex, ey, ez]) => {
      for (let p = 0; p < PER; p++) {
        aX[idx] = ex + (rand(idx * 3.1) - 0.5) * 0.3;
        aY[idx] = ey;
        aZ[idx] = ez + (rand(idx * 5.7) - 0.5) * 0.3;
        aPhase[idx] = rand(idx * 9.3);
        // Sparse, occasional drips rather than a constant stream
        aSpeed[idx] = 0.05 + rand(idx * 1.7) * 0.09;
        pos[idx*3]=aX[idx]; pos[idx*3+1]=aY[idx]; pos[idx*3+2]=aZ[idx];
        idx++;
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aX', new THREE.BufferAttribute(aX, 1));
    g.setAttribute('aY', new THREE.BufferAttribute(aY, 1));
    g.setAttribute('aZ', new THREE.BufferAttribute(aZ, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
    return g;
  }, []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

// ─── Wind-reactive loose objects — a newspaper page, a plastic bag, a few
//     leaves. Subtle and infrequent: small drift with occasional gusts. ─────
function WindDebris() {
  const paperRef = useRef<THREE.Mesh>(null);
  const bagRef   = useRef<THREE.Mesh>(null);
  const leafRefs = useRef<(THREE.Mesh | null)[]>([]);

  const paperBase = useMemo(() => new THREE.Vector3(14, 0.05, 24), []);
  const bagBase   = useMemo(() => new THREE.Vector3(-22, 0.35, 10), []);
  const leafBases = useMemo(() => [
    new THREE.Vector3(2, 0.03, -2),
    new THREE.Vector3(-10, 0.03, 6),
    new THREE.Vector3(18, 0.03, -20),
  ], []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Gust envelope — long calm stretches punctuated by brief gusts.
    const gust = Math.max(0, Math.sin(t * 0.09) - 0.72) * 3.4;

    if (paperRef.current) {
      paperRef.current.position.x = paperBase.x + Math.sin(t * 0.22) * (0.6 + gust * 1.4);
      paperRef.current.position.z = paperBase.z + Math.cos(t * 0.17) * (0.5 + gust * 1.1);
      paperRef.current.rotation.y += (0.004 + gust * 0.02);
      paperRef.current.rotation.x = 0.05 * Math.sin(t * 0.6);
    }
    if (bagRef.current) {
      bagRef.current.position.x = bagBase.x + Math.sin(t * 0.13 + 1.1) * (0.8 + gust * 1.8);
      bagRef.current.position.y = bagBase.y + Math.max(0, Math.sin(t * 0.6)) * gust * 0.4 + 0.05;
      bagRef.current.rotation.z += 0.006 + gust * 0.03;
      bagRef.current.rotation.y += 0.003;
    }
    leafRefs.current.forEach((leaf, i) => {
      if (!leaf) return;
      const base = leafBases[i];
      const phase = i * 1.7;
      leaf.position.x = base.x + Math.sin(t * 0.31 + phase) * (0.35 + gust * 0.9);
      leaf.position.z = base.z + Math.cos(t * 0.27 + phase) * (0.3 + gust * 0.8);
      leaf.rotation.y += 0.01 + gust * 0.05;
      leaf.rotation.x = 0.15 * Math.sin(t * 0.9 + phase);
    });
  });

  return (
    <group>
      <mesh ref={paperRef} position={[paperBase.x, paperBase.y, paperBase.z]} rotation={[-Math.PI / 2 + 0.05, 0, 0]}>
        <planeGeometry args={[0.42, 0.55]} />
        <meshStandardMaterial color="#cfcabd" roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={bagRef} position={[bagBase.x, bagBase.y, bagBase.z]}>
        <sphereGeometry args={[0.22, 6, 5]} />
        <meshStandardMaterial color="#e7e7e0" roughness={0.4} metalness={0.05} transparent opacity={0.72} />
      </mesh>
      {leafBases.map((b, i) => (
        <mesh
          key={i}
          ref={(el) => { leafRefs.current[i] = el; }}
          position={[b.x, b.y, b.z]}
          rotation={[-Math.PI / 2, 0, i]}
        >
          <circleGeometry args={[0.14, 5]} />
          <meshStandardMaterial color="#6a5a2e" roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Maintenance decals — stencilled markings, warning signs, numbered labels
function MaintenanceDecals() {
  const warnTex = useMemo(() => makeDecalTexture((ctx, w, h) => {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#d9b13a';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#d9b13a';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CAUTION', w / 2, h / 2 - 14);
    ctx.font = '20px sans-serif';
    ctx.fillText('ROOF ACCESS', w / 2, h / 2 + 24);
  }), []);

  const noStepTex = useMemo(() => makeDecalTexture((ctx, w, h) => {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#c7cad0';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.55;
    ctx.fillText('NO STEP', w / 2, h / 2);
  }), []);

  const labelTex = useMemo(() => makeDecalTexture((ctx, w, h) => {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9aa0a8';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.62;
    ctx.fillText('UNIT 04-B', w / 2, h / 2);
  }, 220, 90), []);

  const arrowTex = useMemo(() => makeDecalTexture((ctx, w, h) => {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(214,196,120,0.4)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(w * 0.2, h * 0.5);
    ctx.lineTo(w * 0.75, h * 0.5);
    ctx.lineTo(w * 0.6, h * 0.3);
    ctx.moveTo(w * 0.75, h * 0.5);
    ctx.lineTo(w * 0.6, h * 0.7);
    ctx.stroke();
  }, 220, 110), []);

  return (
    <group>
      {/* Warning sign on utility panel A */}
      <mesh position={[-50.24, 1.15, -5]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.7, 0.44]} />
        <meshBasicMaterial map={warnTex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Numbered equipment label on HVAC B */}
      <mesh position={[11, 2.1, -2.73]}>
        <planeGeometry args={[1.1, 0.45]} />
        <meshBasicMaterial map={labelTex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Faded stencilled "NO STEP" near a drain cover */}
      <mesh position={[6, 0.02, 15]} rotation={[-Math.PI / 2, 0, 0.2]}>
        <planeGeometry args={[2.2, 1.0]} />
        <meshBasicMaterial map={noStepTex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      {/* Faded directional arrow painted toward the roof hatch */}
      <mesh position={[-24, 0.02, -10]} rotation={[-Math.PI / 2, 0, Math.PI]}>
        <planeGeometry args={[2.2, 1.1]} />
        <meshBasicMaterial map={arrowTex} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ─── Public entry point — mount once alongside the existing <Rooftop /> ─────
export function RooftopDetails() {
  return (
    <group>
      <RooftopWear />
      <RooftopClutter />
      <SafetyRailings />
      <MaintenanceLadder />
      <ExtraPuddles />
      <DrainFlowStreaks />
      <EquipmentDrips />
      <WindDebris />
      <MaintenanceDecals />
    </group>
  );
}
