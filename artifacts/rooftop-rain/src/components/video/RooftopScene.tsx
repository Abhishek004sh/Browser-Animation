import React, { useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, extend } from '@react-three/fiber';
import * as THREE from 'three';
import { motion } from 'framer-motion';
import { shaderMaterial } from '@react-three/drei';

// ─── Shader materials ──────────────────────────────────────────────────────────

const SteamMaterial = shaderMaterial(
  { uTime: 0 },
  `uniform float uTime; attribute float aPhase;
   void main() {
     vec3 p = position;
     float t = fract(aPhase + uTime * 0.09);
     float spread = t * t * 4.8;
     p.x += sin(uTime * 0.45 + aPhase * 7.3) * spread;
     p.y += t * 20.0;
     p.z += cos(uTime * 0.38 + aPhase * 5.8) * spread;
     gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
     float alpha = max(0.0, 1.0 - t);
     gl_PointSize = max(1.5, alpha * 16.0);
   }`,
  `void main() { gl_FragColor = vec4(0.85, 0.88, 0.95, 0.20); }`
);

extend({ SteamMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    steamMaterial: React.ComponentProps<typeof SteamMaterial> & { attach?: string };
  }
}

// ─── Module-level shared weather state (written by DynamicWeather, read by all) ─
const W = { phase: 0.55, lightning: 0.0, _nextStrike: 14.0 };

// ─── Window ShaderMaterial (GPU-animated per-instance) ────────────────────────
// Three.js (r131+) auto-injects instanceMatrix into custom ShaderMaterial
// when the parent object is an InstancedMesh.
function makeWindowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aPhase;
      attribute vec3  aColor;
      uniform  float  uTime;
      varying  vec3   vCol;
      void main() {
        float speed  = 0.08 + aPhase * 0.42;
        float wave   = 0.55 + 0.45 * sin(uTime * speed + aPhase * 6.28318);
        float onOff  = step(0.28, fract(aPhase * 7.38906));
        // Occasional fast-flicker override (offices turning off/on)
        float flick  = step(0.97, fract(aPhase * 31.4 + uTime * (0.05 + aPhase * 0.15)));
        vCol = aColor * wave * max(onOff, flick) * 1.75;
        gl_Position  = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vCol;
      void main() { gl_FragColor = vec4(vCol, 1.0); }
    `,
    side: THREE.FrontSide,
  });
}

// ─── Camera ───────────────────────────────────────────────────────────────────
function CameraRig() {
  useFrame((state) => {
    const t    = (state.clock.elapsedTime % 60) / 60;
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

// ─── Cinematic Rain — GPU particle system ────────────────────────────────────

function makeFarRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWindX: { value: 0 }, uWindZ: { value: 0 } },
    vertexShader: `
      attribute float aX; attribute float aY0; attribute float aZ;
      attribute float aSpeed; attribute float aSize;
      uniform float uTime; uniform float uWindX; uniform float uWindZ;
      varying float vAlpha;
      void main() {
        float y    = mod(aY0 - uTime * aSpeed * 20.0, 72.0) - 6.0;
        vec4 mvPos = modelViewMatrix * vec4(aX + uWindX * 1.2, y, aZ + uWindZ * 0.8, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float dist  = max(1.0, -mvPos.z);
        gl_PointSize = clamp((aSize * 420.0) / dist, 0.5, 18.0);
        vAlpha = (1.0 - clamp((dist - 10.0) / 150.0, 0.0, 1.0) * 0.8) * 0.30;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        vec2  uv    = gl_PointCoord * 2.0 - 1.0;
        float d     = length(uv * vec2(3.2, 1.0));
        float alpha = (1.0 - smoothstep(0.1, 1.0, d)) * vAlpha;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(0.46, 0.58, 0.74, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  });
}

function makeNearRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWindX: { value: 0 }, uWindZ: { value: 0 } },
    vertexShader: `
      attribute float aX; attribute float aY0; attribute float aZ;
      attribute float aSpeed; attribute float aSize;
      uniform float uTime; uniform float uWindX; uniform float uWindZ;
      varying float vAlpha;
      void main() {
        float y    = mod(aY0 - uTime * aSpeed * 22.0, 75.0) - 8.0;
        vec4 mvPos = modelViewMatrix * vec4(aX + uWindX * 2.8, y, aZ + uWindZ * 1.8, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float dist   = max(1.0, -mvPos.z);
        gl_PointSize = clamp((aSize * 620.0) / dist, 1.0, 52.0);
        vAlpha = 1.0 - clamp((dist - 4.0) / 100.0, 0.0, 1.0) * 0.75;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        vec2  uv      = gl_PointCoord * 2.0 - 1.0;
        // Streak: narrow in x, bright head (uv.y=-1) fading to tail (uv.y=+1)
        float xNarrow = 1.0 - smoothstep(0.0, 1.0, abs(uv.x) * 5.5);
        float yFade   = 1.0 - smoothstep(-0.95, 1.15, uv.y);
        float streak  = xNarrow * yFade;
        // Specular core at the head
        float core    = 1.0 - smoothstep(0.0, 1.0, length(uv * vec2(8.5, 2.0)));
        float alpha   = (streak * 0.62 + core * 0.44) * vAlpha;
        if (alpha < 0.004) discard;
        gl_FragColor  = vec4(mix(vec3(0.53, 0.68, 0.90), vec3(0.92, 0.96, 1.0), core * 0.48), alpha);
      }
    `,
    transparent: true, depthWrite: false,
  });
}

function makeRainGeo(
  count: number, xRange: number, zCenter: number, zRange: number,
  sizeMin: number, sizeMax: number, speedMin: number, speedMax: number,
) {
  const g      = new THREE.BufferGeometry();
  const aX     = new Float32Array(count);
  const aY0    = new Float32Array(count);
  const aZ     = new Float32Array(count);
  const aSpeed = new Float32Array(count);
  const aSize  = new Float32Array(count);
  const pos    = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    aX[i]     = (Math.random() - 0.5) * xRange;
    aY0[i]    = Math.random() * 75;
    aZ[i]     = zCenter + (Math.random() - 0.5) * zRange;
    aSpeed[i] = speedMin + Math.random() * (speedMax - speedMin);
    aSize[i]  = sizeMin  + Math.random() * (sizeMax  - sizeMin);
    pos[i*3]  = aX[i]; pos[i*3+1] = aY0[i]; pos[i*3+2] = aZ[i];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aX',     new THREE.BufferAttribute(aX, 1));
  g.setAttribute('aY0',    new THREE.BufferAttribute(aY0, 1));
  g.setAttribute('aZ',     new THREE.BufferAttribute(aZ, 1));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
  g.setAttribute('aSize',  new THREE.BufferAttribute(aSize, 1));
  return g;
}

function CinematicRain() {
  const farMat  = useMemo(() => makeFarRainMaterial(),  []);
  const nearMat = useMemo(() => makeNearRainMaterial(), []);
  // Far layer: wide background, soft blobs
  const farGeo  = useMemo(() => makeRainGeo(5000,  320, -170, 260, 0.22, 0.62, 0.50, 1.20), []);
  // Near layer: tighter around rooftop, elongated streaks, perspective-sized
  const nearGeo = useMemo(() => makeRainGeo(15000, 190,  -20, 130, 0.42, 1.62, 0.72, 1.84), []);

  useFrame((state, dt) => {
    const t    = state.clock.elapsedTime;
    // Smooth compound wind gusts with slow directional drift
    const gust = 0.55 + 0.45 * Math.sin(t * 0.41) + 0.28 * Math.abs(Math.sin(t * 1.12));
    const wx   = (Math.sin(t * 0.23) * 0.85 + Math.sin(t * 0.11 + 1.3) * 0.55) * gust;
    const wz   = (Math.cos(t * 0.17 + 0.7) * 0.32 + Math.sin(t * 0.29) * 0.22) * gust;
    for (const m of [farMat, nearMat]) {
      m.uniforms.uTime.value  += dt;
      m.uniforms.uWindX.value  = wx;
      m.uniforms.uWindZ.value  = wz;
    }
  });

  return (
    <>
      <points geometry={farGeo}  material={farMat}  frustumCulled={false} />
      <points geometry={nearGeo} material={nearMat} frustumCulled={false} />
    </>
  );
}

// ─── Splash impacts ───────────────────────────────────────────────────────────
function SplashParticles() {
  const COUNT = 2800;
  const mat   = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aX;    attribute float aZ;    attribute float aPhase;
      attribute float aVelX; attribute float aVelY; attribute float aVelZ; attribute float aRate;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        float t   = fract(aPhase + uTime * aRate);
        float y   = aVelY * t - 4.5 * t * t;
        float vis = step(0.002, y);
        vec4 mvPos  = modelViewMatrix * vec4(aX + aVelX * t, y, aZ + aVelZ * t, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float dist  = max(1.0, -mvPos.z);
        gl_PointSize = clamp(95.0 / dist, 0.5, 3.8);
        vAlpha = (1.0 - t) * smoothstep(0.0, 0.07, t) * vis * 0.58;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float r     = length(gl_PointCoord - 0.5);
        float alpha = (1.0 - smoothstep(0.05, 0.5, r)) * vAlpha;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(0.76, 0.89, 1.0, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  const geo = useMemo(() => {
    const g      = new THREE.BufferGeometry();
    const aX     = new Float32Array(COUNT); const aZ     = new Float32Array(COUNT);
    const aPhase = new Float32Array(COUNT); const aVelX  = new Float32Array(COUNT);
    const aVelY  = new Float32Array(COUNT); const aVelZ  = new Float32Array(COUNT);
    const aRate  = new Float32Array(COUNT); const pos    = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      aX[i]     = (Math.random() - 0.5) * 112;
      aZ[i]     = (Math.random() - 0.5) * 112 - 20;
      aPhase[i] = Math.random();
      const ang  = Math.random() * Math.PI * 2;
      const h    = Math.random() * 0.65;
      aVelX[i]  = Math.cos(ang) * h;
      aVelZ[i]  = Math.sin(ang) * h;
      aVelY[i]  = 0.45 + Math.random() * 1.85;
      aRate[i]  = 0.35 + Math.random() * 0.85;
      pos[i*3]  = aX[i]; pos[i*3+2] = aZ[i];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aX',     new THREE.BufferAttribute(aX,    1));
    g.setAttribute('aZ',     new THREE.BufferAttribute(aZ,    1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase,1));
    g.setAttribute('aVelX',  new THREE.BufferAttribute(aVelX, 1));
    g.setAttribute('aVelY',  new THREE.BufferAttribute(aVelY, 1));
    g.setAttribute('aVelZ',  new THREE.BufferAttribute(aVelZ, 1));
    g.setAttribute('aRate',  new THREE.BufferAttribute(aRate, 1));
    return g;
  }, []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

// ─── Roof edge drips ──────────────────────────────────────────────────────────
function RoofDrips() {
  const COUNT = 600;
  const mat   = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aX; attribute float aZ;
      attribute float aPhase; attribute float aSpeed;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        float t    = fract(aPhase + uTime * aSpeed);
        float y    = 1.8 - t * 14.0;
        vec4 mvPos = modelViewMatrix * vec4(aX, y, aZ, 1.0);
        gl_Position = projectionMatrix * mvPos;
        float dist  = max(1.0, -mvPos.z);
        gl_PointSize = clamp(65.0 / dist, 0.4, 3.5);
        vAlpha = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.84, 1.0, t)) * 0.68;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        vec2  uv    = gl_PointCoord * 2.0 - 1.0;
        float xMask = 1.0 - smoothstep(0.0, 1.0, abs(uv.x) * 4.2);
        float yMask = 1.0 - smoothstep(-0.8, 1.1, uv.y);
        float alpha = xMask * yMask * vAlpha;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(0.64, 0.80, 0.96, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  const geo = useMemo(() => {
    const g      = new THREE.BufferGeometry();
    const aX     = new Float32Array(COUNT); const aZ     = new Float32Array(COUNT);
    const aPhase = new Float32Array(COUNT); const aSpeed = new Float32Array(COUNT);
    const pos    = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const edge = Math.floor(Math.random() * 4);
      if      (edge === 0) { aX[i] = (Math.random()-0.5)*118; aZ[i] =  38.0; }
      else if (edge === 1) { aX[i] = (Math.random()-0.5)*118; aZ[i] = -79.0; }
      else if (edge === 2) { aX[i] = -59.0; aZ[i] = -79 + Math.random()*117; }
      else                 { aX[i] =  59.0; aZ[i] = -79 + Math.random()*117; }
      aPhase[i] = Math.random();
      aSpeed[i] = 0.11 + Math.random() * 0.26;
      pos[i*3]  = aX[i]; pos[i*3+1] = 1.8; pos[i*3+2] = aZ[i];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aX',     new THREE.BufferAttribute(aX,    1));
    g.setAttribute('aZ',     new THREE.BufferAttribute(aZ,    1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase,1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed,1));
    return g;
  }, []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });
  return <points geometry={geo} material={mat} frustumCulled={false} />;
}

// ─── Steam from HVAC / vents ──────────────────────────────────────────────────
function Steam() {
  const matRef   = useRef<any>(null);
  const EMITTERS: [number, number, number][] = [
    [-16, 3.6, -14], [11, 3.2, -5], [25, 2.7, -18],
    [20, 13.0, -28], [-5, 1.3, -36], [33, 1.3, -46],
    // Distant skyline rooftops
    [-88, 55, -115], [105, 70, -135], [72, 112, -188],
    [-60, 40, -95],  [148, 87, -165], [-45, 64, -210],
  ];
  const PER = 38;
  const geo = useMemo(() => {
    const g   = new THREE.BufferGeometry();
    const tot = EMITTERS.length * PER;
    const pos = new Float32Array(tot * 3);
    const ph  = new Float32Array(tot);
    let idx = 0;
    EMITTERS.forEach(([ex, ey, ez]) => {
      for (let p = 0; p < PER; p++) {
        pos[idx*3]=ex; pos[idx*3+1]=ey; pos[idx*3+2]=ez;
        ph[idx] = Math.random(); idx++;
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPhase',   new THREE.BufferAttribute(ph, 1));
    return g;
  }, []);
  useFrame((_, dt) => { if (matRef.current) matRef.current.uTime += dt; });
  return <points geometry={geo}><steamMaterial ref={matRef} transparent depthWrite={false} /></points>;
}

// ─── Skyline — 220 buildings + GPU-animated windows ──────────────────────────
function Skyline() {
  const BUILD_COUNT = 220;

  const { bMatrices, wMatrices, wColors, bTopPositions } = useMemo(() => {
    const bMat: THREE.Matrix4[]   = [];
    const wMat: THREE.Matrix4[]   = [];
    const wCol: THREE.Color[]     = [];
    const tops: [number,number,number][] = [];
    const dummy = new THREE.Object3D();
    const c     = new THREE.Color();
    const warm  = ['#ffe4b0','#ffd580','#fff0c0','#ffeac0'];
    const cool  = ['#c0d8ff','#d0e8ff','#a8c8ff'];
    const neon  = ['#40ffcc','#ff4488','#88ffff','#ffaa00'];

    for (let i = 0; i < BUILD_COUNT; i++) {
      const ring  = Math.floor(i / 22);
      const angle = (i % 22) * (Math.PI * 2 / 22) + ring * 0.4;
      const rad   = 55 + ring * 28 + Math.random() * 18;
      const bx    = Math.cos(angle) * rad + (Math.random()-0.5) * 20;
      const bz    = -80 + Math.sin(angle) * rad * 0.45 + (Math.random()-0.5) * 15;
      const bw    = 8  + Math.random() * 28;
      const bd    = 8  + Math.random() * 28;
      const bh    = 25 + Math.random() * 220;

      dummy.position.set(bx, bh/2, bz);
      dummy.scale.set(bw, bh, bd);
      dummy.updateMatrix();
      bMat.push(dummy.matrix.clone());
      tops.push([bx, bh, bz]);

      const frontZ = bz + bd/2 + 0.2;
      const cols   = Math.max(2, Math.floor(bw/5));
      const rows   = Math.max(2, Math.floor(bh/6));
      const stepX  = bw / (cols + 1);
      const stepY  = bh / (rows + 1);

      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          if (Math.random() > 0.55) continue;
          dummy.position.set(bx - bw/2 + stepX*(col+1), stepY*(r+1), frontZ);
          dummy.scale.set(Math.min(stepX*0.55,3), Math.min(stepY*0.6,3.5), 1);
          dummy.rotation.set(0,0,0);
          dummy.updateMatrix();
          wMat.push(dummy.matrix.clone());
          const rng = Math.random();
          if (rng < 0.06)      c.set(neon[Math.floor(Math.random()*neon.length)]);
          else if (rng < 0.45) c.set(warm[Math.floor(Math.random()*warm.length)]);
          else                 c.set(cool[Math.floor(Math.random()*cool.length)]);
          wCol.push(c.clone());
        }
      }
    }
    return { bMatrices: bMat, wMatrices: wMat, wColors: wCol, bTopPositions: tops };
  }, []);

  const windowMat    = useMemo(() => makeWindowMaterial(), []);
  const buildRef     = useRef<THREE.InstancedMesh>(null);
  const windowRef    = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    if (buildRef.current) {
      bMatrices.forEach((m, i) => buildRef.current!.setMatrixAt(i, m));
      buildRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [bMatrices]);

  useEffect(() => {
    if (!windowRef.current) return;
    wMatrices.forEach((m, i) => windowRef.current!.setMatrixAt(i, m));
    windowRef.current.instanceMatrix.needsUpdate = true;
    const n = wMatrices.length;
    const ph  = new Float32Array(n);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      ph[i] = Math.random();
      col[i*3]=wColors[i].r; col[i*3+1]=wColors[i].g; col[i*3+2]=wColors[i].b;
    }
    windowRef.current.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    windowRef.current.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  }, [wMatrices, wColors]);

  useFrame((_, dt) => { windowMat.uniforms.uTime.value += dt; });

  return (
    <group>
      <instancedMesh ref={buildRef} args={[undefined, undefined, BUILD_COUNT]}>
        <boxGeometry args={[1,1,1]} />
        <meshStandardMaterial color="#0b0e14" roughness={0.92} metalness={0.08} />
      </instancedMesh>
      {wMatrices.length > 0 && (
        <instancedMesh ref={windowRef} args={[undefined, undefined, wMatrices.length]} material={windowMat}>
          <planeGeometry args={[1,1]} />
        </instancedMesh>
      )}
    </group>
  );
}

// ─── Building rooftop blinkers ────────────────────────────────────────────────
function BuildingBlinkers() {
  const COUNT = 48;
  const { positions, phases } = useMemo(() => {
    const pos: [number,number,number][] = [];
    const ph = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const ring  = Math.floor(i / 10);
      const angle = (i % 10) * (Math.PI * 2 / 10) + ring * 0.7;
      const rad   = 60 + ring * 35;
      const x     = Math.cos(angle) * rad + (Math.random()-0.5) * 30;
      const z     = -90 + Math.sin(angle) * rad * 0.5 + (Math.random()-0.5) * 20;
      const y     = 55 + Math.random() * 200;
      pos.push([x, y, z]);
      ph[i] = Math.random();
    }
    return { positions: pos, phases: ph };
  }, []);

  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    positions.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(0.8);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
    const red = new THREE.Color('#ff1100');
    for (let i = 0; i < COUNT; i++) meshRef.current.setColorAt(i, red);
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  }, [positions]);

  const _c = useMemo(() => new THREE.Color(), []);
  useFrame((state) => {
    if (!meshRef.current?.instanceColor) return;
    const t = state.clock.elapsedTime;
    let dirty = false;
    for (let i = 0; i < COUNT; i++) {
      const freq = 1.2 + phases[i] * 2.2;
      const on   = Math.sin(t * freq + phases[i] * 6.28) > 0.65;
      _c.setRGB(on ? 1 : 0.04, 0, 0);
      meshRef.current.setColorAt(i, _c);
      dirty = true;
    }
    if (dirty) meshRef.current.instanceColor!.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]}>
      <sphereGeometry args={[1, 5, 4]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

// ─── Cars — white headlights + red taillights ────────────────────────────────
interface CarState {
  type: 'EW' | 'NS'; x: number; y: number; z: number; speed: number; dir: number;
}
function Cars() {
  const EW_Z = [-100, -128, -160, -192];
  const NS_X = [-58, -8, 48, 98];

  const cars = useMemo<CarState[]>(() => {
    const list: CarState[] = [];
    // 36 E-W cars
    for (let i = 0; i < 36; i++) {
      const streetZ = EW_Z[i % EW_Z.length] + (Math.random()-0.5)*5;
      const dir     = i < 18 ? 1 : -1;
      list.push({ type:'EW', x:(Math.random()-0.5)*340, y:1, z:streetZ, speed:dir*(12+Math.random()*18), dir });
    }
    // 24 N-S cars
    for (let i = 0; i < 24; i++) {
      const streetX = NS_X[i % NS_X.length] + (Math.random()-0.5)*5;
      const dir     = i < 12 ? 1 : -1;
      list.push({ type:'NS', x:streetX, y:1, z:-80-Math.random()*180, speed:dir*(10+Math.random()*15), dir });
    }
    return list;
  }, []);

  const N           = cars.length;
  const stateRef    = useRef(cars.map(c => ({ ...c })));
  const headRef     = useRef<THREE.InstancedMesh>(null);
  const tailRef     = useRef<THREE.InstancedMesh>(null);
  const dummy       = useMemo(() => new THREE.Object3D(), []);

  // Initial placement
  useEffect(() => {
    if (!headRef.current || !tailRef.current) return;
    stateRef.current.forEach((c, i) => {
      const offX = c.type==='EW' ? c.dir*1.8 : 0;
      const offZ = c.type==='NS' ? c.dir*1.8 : 0;
      dummy.position.set(c.x+offX, c.y, c.z+offZ); dummy.scale.setScalar(0.5); dummy.updateMatrix();
      headRef.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(c.x-offX, c.y, c.z-offZ); dummy.updateMatrix();
      tailRef.current!.setMatrixAt(i, dummy.matrix);
    });
    headRef.current.instanceMatrix.needsUpdate = true;
    tailRef.current.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame((_, dt) => {
    if (!headRef.current || !tailRef.current) return;
    stateRef.current.forEach((c, i) => {
      if (c.type==='EW') {
        c.x += c.speed * dt;
        if (c.x >  200) c.x = -200;
        if (c.x < -200) c.x =  200;
      } else {
        c.z += c.speed * dt;
        if (c.z >  50)  c.z = -220;
        if (c.z < -220) c.z =  50;
      }
      const offX = c.type==='EW' ? c.dir*1.8 : 0;
      const offZ = c.type==='NS' ? c.dir*1.8 : 0;
      dummy.position.set(c.x+offX, c.y, c.z+offZ); dummy.scale.setScalar(0.55); dummy.updateMatrix();
      headRef.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(c.x-offX*0.8, c.y, c.z-offZ*0.8); dummy.scale.setScalar(0.45); dummy.updateMatrix();
      tailRef.current!.setMatrixAt(i, dummy.matrix);
    });
    headRef.current.instanceMatrix.needsUpdate = true;
    tailRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {/* Headlights — white/warm */}
      <instancedMesh ref={headRef} args={[undefined, undefined, N]}>
        <sphereGeometry args={[1, 4, 3]} />
        <meshBasicMaterial color="#fff8e8" toneMapped={false} />
      </instancedMesh>
      {/* Taillights — red */}
      <instancedMesh ref={tailRef} args={[undefined, undefined, N]}>
        <sphereGeometry args={[1, 4, 3]} />
        <meshBasicMaterial color="#ff2200" toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

// ─── Aircraft — helicopters + airplanes ──────────────────────────────────────
function Aircraft() {
  const h1Ref      = useRef<THREE.Group>(null);
  const h2Ref      = useRef<THREE.Group>(null);
  const h1Beacon   = useRef<THREE.PointLight>(null);
  const h2Beacon   = useRef<THREE.PointLight>(null);
  const p1Ref      = useRef<THREE.Group>(null);
  const p2Ref      = useRef<THREE.Group>(null);
  const p1Strobe   = useRef<THREE.PointLight>(null);
  const p2Strobe   = useRef<THREE.PointLight>(null);

  const h1T = useRef(0);
  const h2T = useRef(0.48);
  const p1X = useRef(-380);
  const p2X = useRef(250);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;

    // Helicopter 1 — slow lazy arc at mid-city depth
    h1T.current += dt * 0.0028;
    if (h1Ref.current) {
      const a = h1T.current * Math.PI * 2;
      h1Ref.current.position.set(
        Math.cos(a) * 170 + 20,
        88 + Math.sin(t * 0.22) * 5,
        Math.sin(a) * 72 - 130
      );
    }
    if (h1Beacon.current) {
      h1Beacon.current.intensity = Math.sin(t * 3.14) > 0.72 ? 6 : 0;
    }

    // Helicopter 2 — slightly different arc
    h2T.current += dt * 0.0019;
    if (h2Ref.current) {
      const a = h2T.current * Math.PI * 2;
      h2Ref.current.position.set(
        Math.cos(a) * 215 - 30,
        112 + Math.sin(t * 0.17) * 6,
        Math.sin(a) * 85 - 155
      );
    }
    if (h2Beacon.current) {
      h2Beacon.current.intensity = Math.sin(t * 2.78 + 2.1) > 0.72 ? 6 : 0;
    }

    // Airplane 1 — slow left-to-right at high altitude
    p1X.current += dt * 20;
    if (p1X.current > 480) p1X.current = -480;
    if (p1Ref.current) {
      p1Ref.current.position.set(p1X.current, 295 + Math.sin(t*0.05)*8, -400);
    }
    if (p1Strobe.current) {
      const st = (t * 1.4) % 1;
      p1Strobe.current.intensity = st < 0.05 || (st > 0.12 && st < 0.17) ? 12 : 0;
    }

    // Airplane 2 — slow right-to-left, higher, further
    p2X.current -= dt * 15;
    if (p2X.current < -480) p2X.current = 480;
    if (p2Ref.current) {
      p2Ref.current.position.set(p2X.current, 340, -460);
    }
    if (p2Strobe.current) {
      const st = ((t + 0.8) * 1.1) % 1;
      p2Strobe.current.intensity = st < 0.05 ? 12 : 0;
    }
  });

  return (
    <group>
      {/* Helicopter 1 */}
      <group ref={h1Ref}>
        <pointLight ref={h1Beacon} color="#ff0000" intensity={0} distance={140} decay={1.8} />
        <pointLight color="#aaccff" intensity={0.5} distance={80} decay={2} />
      </group>
      {/* Helicopter 2 */}
      <group ref={h2Ref}>
        <pointLight ref={h2Beacon} color="#ff0000" intensity={0} distance={120} decay={1.8} />
        <pointLight color="#aaccff" intensity={0.4} distance={70} decay={2} />
      </group>
      {/* Airplane 1 */}
      <group ref={p1Ref}>
        <pointLight ref={p1Strobe} color="#ffffff" intensity={0} distance={300} decay={1.5} />
        <pointLight color="#ff3300" intensity={0.6} distance={100} decay={2} />
        <pointLight color="#00aa44" intensity={0.6} distance={100} decay={2} />
      </group>
      {/* Airplane 2 */}
      <group ref={p2Ref}>
        <pointLight ref={p2Strobe} color="#ffffff" intensity={0} distance={300} decay={1.5} />
        <pointLight color="#ff3300" intensity={0.4} distance={80} decay={2} />
      </group>
    </group>
  );
}

// ─── Atmospheric haze layers ──────────────────────────────────────────────────
function AtmosphericHaze() {
  return (
    <group>
      {/* Deep-city haze band */}
      <mesh position={[0, 28, -180]} rotation={[0.04, 0, 0]}>
        <planeGeometry args={[700, 220]} />
        <meshBasicMaterial color="#09101e" transparent opacity={0.14} depthWrite={false} />
      </mesh>
      {/* Low ground-level glow */}
      <mesh position={[0, 4, -120]} rotation={[-0.06, 0, 0]}>
        <planeGeometry args={[500, 55]} />
        <meshBasicMaterial color="#0d1828" transparent opacity={0.10} depthWrite={false} />
      </mesh>
      {/* Very distant murk */}
      <mesh position={[0, 60, -350]}>
        <planeGeometry args={[900, 300]} />
        <meshBasicMaterial color="#06090f" transparent opacity={0.22} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ─── Distant skyline billboards — instanced, GPU color-cycling ────────────────
function makeDistantBillboardMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float aPhase;
      attribute vec3  aCol1;
      attribute vec3  aCol2;
      uniform  float  uTime;
      varying  vec3   vCol;
      void main() {
        float t     = 0.5 + 0.5 * sin(uTime * 0.22 + aPhase * 6.28318);
        float flick = step(0.94, fract(aPhase * 17.3 + uTime * (0.08 + aPhase * 0.12)));
        vCol = mix(aCol1, aCol2, max(t, flick));
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vCol;
      void main() { gl_FragColor = vec4(vCol, 1.0); }
    `,
    side: THREE.FrontSide,
  });
  (mat as any).toneMapped = false;
  return mat;
}

function DistantBillboards() {
  // [x, y, z, width, height] — placed on distant building facades
  const BOARDS: [number, number, number, number, number][] = [
    [-88,  52, -115, 30, 14],
    [105,  68, -135, 26, 12],
    [-60,  38,  -95, 22, 10],
    [145,  85, -165, 32, 16],
    [-130, 44, -105, 20, 10],
    [ 72, 110, -190, 28, 14],
    [ -45, 62, -210, 24, 12],
    [190,  50, -130, 18,  9],
  ];
  const COLORS: [string, string][] = [
    ['#ff3300', '#ff9900'],
    ['#00ccff', '#0044ff'],
    ['#ff00aa', '#ffff00'],
    ['#00ff88', '#00aaff'],
    ['#ff6600', '#ff0055'],
    ['#44ff00', '#00ffcc'],
    ['#ff2288', '#aa00ff'],
    ['#ffcc00', '#ff4400'],
  ];

  const COUNT  = BOARDS.length;
  const mat    = useMemo(() => makeDistantBillboardMaterial(), []);
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    if (!meshRef.current) return;
    const dummy = new THREE.Object3D();
    const col1  = new Float32Array(COUNT * 3);
    const col2  = new Float32Array(COUNT * 3);
    const phase = new Float32Array(COUNT);
    const c1 = new THREE.Color();
    const c2 = new THREE.Color();
    BOARDS.forEach(([x, y, z, w, h], i) => {
      dummy.position.set(x, y, z);
      dummy.scale.set(w, h, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
      c1.set(COLORS[i % COLORS.length][0]);
      c2.set(COLORS[i % COLORS.length][1]);
      col1[i*3]=c1.r; col1[i*3+1]=c1.g; col1[i*3+2]=c1.b;
      col2[i*3]=c2.r; col2[i*3+1]=c2.g; col2[i*3+2]=c2.b;
      phase[i] = Math.random();
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    meshRef.current.geometry.setAttribute('aCol1',  new THREE.InstancedBufferAttribute(col1, 3));
    meshRef.current.geometry.setAttribute('aCol2',  new THREE.InstancedBufferAttribute(col2, 3));
  }, []);

  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, COUNT]} material={mat}>
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

// ─── Rooftop — floor, ledges, details, animated billboards & blinkers ─────────
function Rooftop() {
  // Billboard material refs for color animation
  const bb1MatRef   = useRef<THREE.MeshBasicMaterial>(null);
  const bb1LightRef = useRef<THREE.PointLight>(null);
  const bb2MatRef   = useRef<THREE.MeshBasicMaterial>(null);
  const bb2LightRef = useRef<THREE.PointLight>(null);

  // Antenna blinker light refs
  const ant1Ref = useRef<THREE.PointLight>(null);
  const ant2Ref = useRef<THREE.PointLight>(null);

  // Billboard scan line refs (animated sweep)
  const scan1Ref = useRef<THREE.Mesh>(null);
  const scan2Ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Billboard 1: warm amber → orange → red cycle
    if (bb1MatRef.current) {
      const p  = t * 0.35;
      const r  = 0.78 + 0.22 * Math.sin(p);
      const g  = 0.22 + 0.20 * Math.sin(p + 1.2);
      bb1MatRef.current.color.setRGB(r, g, 0.02);
    }
    if (bb1LightRef.current && bb1MatRef.current) {
      bb1LightRef.current.color.copy(bb1MatRef.current.color);
      bb1LightRef.current.intensity = 2.2 + 0.8 * Math.sin(t * 0.35);
    }

    // Billboard 2: cyan → blue → teal cycle
    if (bb2MatRef.current) {
      const p  = t * 0.27 + 1.8;
      const b  = 0.65 + 0.35 * Math.sin(p);
      const g  = 0.38 + 0.30 * Math.sin(p + 0.9);
      bb2MatRef.current.color.setRGB(0.02, g, b);
    }
    if (bb2LightRef.current && bb2MatRef.current) {
      bb2LightRef.current.color.copy(bb2MatRef.current.color);
      bb2LightRef.current.intensity = 1.9 + 0.6 * Math.sin(t * 0.27 + 1.8);
    }

    // Antenna blinkers
    if (ant1Ref.current) {
      ant1Ref.current.intensity = Math.sin(t * 3.14) > 0.68 ? 4.5 : 0;
    }
    if (ant2Ref.current) {
      ant2Ref.current.intensity = Math.sin(t * 2.6 + 1.4) > 0.68 ? 3.5 : 0;
    }

    // Billboard scan lines — sweep from bottom to top of each face
    if (scan1Ref.current) {
      // Face center y=12, height=9 → spans 7.5 to 16.5 in group-local space
      scan1Ref.current.position.y = 7.5 + ((t * 0.38) % 1) * 9.0;
    }
    if (scan2Ref.current) {
      // Face center y=10, height=7 → spans 6.5 to 13.5 in group-local space
      scan2Ref.current.position.y = 6.5 + ((t * 0.31 + 0.5) % 1) * 7.0;
    }
  });

  return (
    <group>
      {/* Concrete floor */}
      <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,-20]}>
        <planeGeometry args={[120,120]} />
        <meshStandardMaterial color="#18191d" roughness={0.97} metalness={0.0} />
      </mesh>

      {/* Ledges */}
      <mesh position={[0,0.9,38]}><boxGeometry args={[120,1.8,1.2]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh position={[-59,0.9,-20]}><boxGeometry args={[1.2,1.8,120]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh position={[59,0.9,-20]}><boxGeometry args={[1.2,1.8,120]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh position={[0,0.9,-79]}><boxGeometry args={[120,1.8,1.2]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>

      {/* Puddles */}
      {([[3,6,0.4],[-7,-12,0.55],[12,-8,0.3],[-14,15,0.5],[20,3,0.45],[-3,-28,0.5],[8,-30,0.35]] as [number,number,number][]).map(([px,pz,sc],i)=>(
        <mesh key={i} position={[px,0.02,pz]} rotation={[-Math.PI/2,0,0]}>
          <circleGeometry args={[3*sc+1.5,24]} />
          <meshPhysicalMaterial roughness={0.01} metalness={0.05} transmission={0.88} ior={1.33} transparent opacity={0.92} color="#1a1f2a" />
        </mesh>
      ))}

      {/* HVAC A */}
      <group position={[-16,0,-14]}>
        <mesh position={[0,1.6,0]}><boxGeometry args={[7,3.2,5]} /><meshStandardMaterial color="#2e3138" roughness={0.88} metalness={0.35} /></mesh>
        <mesh position={[0,3.22,0]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[5,3.5]} /><meshStandardMaterial color="#111315" roughness={0.9} /></mesh>
        {[-1.5,-0.5,0.5,1.5].map((dx,i)=><mesh key={i} position={[dx,1.6,2.55]}><boxGeometry args={[0.08,2.6,0.12]} /><meshStandardMaterial color="#111" /></mesh>)}
      </group>

      {/* HVAC B */}
      <group position={[11,0,-5]}>
        <mesh position={[0,1.5,0]}><boxGeometry args={[5,3,4.5]} /><meshStandardMaterial color="#2e3138" roughness={0.88} metalness={0.35} /></mesh>
        {[-1,0,1].map((dx,i)=><mesh key={i} position={[dx,1.5,2.28]}><boxGeometry args={[0.07,2.4,0.1]} /><meshStandardMaterial color="#111" /></mesh>)}
      </group>

      {/* HVAC C */}
      <group position={[25,0,-18]}>
        <mesh position={[0,1.2,0]}><boxGeometry args={[8,2.4,5]} /><meshStandardMaterial color="#333840" roughness={0.85} metalness={0.4} /></mesh>
        <mesh position={[0,2.42,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[1.2,1.6,24]} /><meshStandardMaterial color="#222" side={THREE.DoubleSide} /></mesh>
      </group>

      {/* Water tank */}
      <group position={[20,0,-28]}>
        {([[-2,-2],[2,-2],[-2,2],[2,2]] as [number,number][]).map(([lx,lz],i)=>(
          <mesh key={i} position={[lx,3.5,lz]}><cylinderGeometry args={[0.14,0.16,7,8]} /><meshStandardMaterial color="#3a3a3a" metalness={0.5} roughness={0.6} /></mesh>
        ))}
        {([[0,3.5,2,Math.PI/2,0,0],[0,3.5,-2,Math.PI/2,0,0],[-2,3.5,0,0,0,Math.PI/2],[2,3.5,0,0,0,Math.PI/2]] as number[][]).map(([x,y,z,rx,ry,rz],i)=>(
          <mesh key={i} position={[x,y,z]} rotation={[rx,ry,rz]}><cylinderGeometry args={[0.05,0.05,4,6]} /><meshStandardMaterial color="#3a3a3a" metalness={0.5} roughness={0.6} /></mesh>
        ))}
        <mesh position={[0,8,0]}><cylinderGeometry args={[2.4,2.6,5,18]} /><meshStandardMaterial color="#5a4a3a" roughness={0.85} metalness={0.1} /></mesh>
        {[6,7.5,9,10.5].map((y,i)=><mesh key={i} position={[0,y,0]}><torusGeometry args={[2.55,0.1,8,24]} /><meshStandardMaterial color="#2a2018" metalness={0.6} roughness={0.5} /></mesh>)}
        <mesh position={[0,11,0]}><coneGeometry args={[2.8,1.8,18]} /><meshStandardMaterial color="#2a2018" roughness={0.9} /></mesh>
      </group>

      {/* Antenna 1 + animated beacon */}
      <group position={[-26,0,-32]}>
        <mesh position={[0,7,0]}><cylinderGeometry args={[0.28,0.45,14,8]} /><meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} /></mesh>
        <mesh position={[0,15.5,0]}><cylinderGeometry args={[0.05,0.1,3,6]} /><meshStandardMaterial color="#888" metalness={0.7} /></mesh>
        <mesh position={[0,17.2,0]}><sphereGeometry args={[0.28,8,8]} /><meshBasicMaterial color="#ff2020" toneMapped={false} /></mesh>
        <pointLight ref={ant1Ref} position={[0,17.2,0]} color="#ff0000" intensity={0} distance={70} decay={2} />
        {[0,Math.PI/2].map((ry,i)=>(
          <mesh key={i} position={[0,12,0]} rotation={[0,ry,Math.PI/2]}><cylinderGeometry args={[0.04,0.04,5,6]} /><meshStandardMaterial color="#666" metalness={0.7} /></mesh>
        ))}
      </group>

      {/* Antenna 2 + animated beacon */}
      <group position={[17,0,-38]}>
        <mesh position={[0,5,0]}><cylinderGeometry args={[0.18,0.28,10,8]} /><meshStandardMaterial color="#555" metalness={0.6} roughness={0.5} /></mesh>
        <mesh position={[0,11,0]}><cylinderGeometry args={[0.03,0.07,2.5,6]} /><meshStandardMaterial color="#888" /></mesh>
        <mesh position={[0,12.3,0]}><sphereGeometry args={[0.2,6,6]} /><meshBasicMaterial color="#ff4040" toneMapped={false} /></mesh>
        <pointLight ref={ant2Ref} position={[0,12.3,0]} color="#ff0000" intensity={0} distance={55} decay={2} />
      </group>

      {/* Billboard 1 — animated orange */}
      <group position={[-2,0,-42]}>
        {[-7.5,7.5].map((px,i)=>(
          <mesh key={i} position={[px,5,0]}><cylinderGeometry args={[0.4,0.5,10,8]} /><meshStandardMaterial color="#1e2025" metalness={0.5} roughness={0.7} /></mesh>
        ))}
        <mesh position={[0,12,0]}><boxGeometry args={[22,10,0.8]} /><meshStandardMaterial color="#0d0f12" roughness={0.8} /></mesh>
        <mesh position={[0,12,0.45]}>
          <planeGeometry args={[21,9]} />
          <meshBasicMaterial ref={bb1MatRef} color="#ff6600" toneMapped={false} />
        </mesh>
        {/* Horizontal scan line — animated sweep */}
        <mesh ref={scan1Ref} position={[0,12,0.46]}>
          <planeGeometry args={[21,0.4]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.09} toneMapped={false} />
        </mesh>
        <pointLight ref={bb1LightRef} position={[0,12,6]} intensity={2.5} color="#ff6600" distance={60} decay={2} />
      </group>

      {/* Billboard 2 — animated cyan */}
      <group position={[38,0,-35]}>
        {[-6,6].map((px,i)=>(
          <mesh key={i} position={[px,4,0]}><cylinderGeometry args={[0.35,0.45,8,8]} /><meshStandardMaterial color="#1e2025" metalness={0.5} roughness={0.7} /></mesh>
        ))}
        <mesh position={[0,10,0]}><boxGeometry args={[18,8,0.7]} /><meshStandardMaterial color="#0d0f12" roughness={0.8} /></mesh>
        <mesh position={[0,10,0.38]}>
          <planeGeometry args={[17,7]} />
          <meshBasicMaterial ref={bb2MatRef} color="#00ccff" toneMapped={false} />
        </mesh>
        {/* Horizontal scan line — animated sweep */}
        <mesh ref={scan2Ref} position={[0,10,0.39]}>
          <planeGeometry args={[17,0.35]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.07} toneMapped={false} />
        </mesh>
        <pointLight ref={bb2LightRef} position={[0,10,5]} intensity={2} color="#00ccff" distance={50} decay={2} />
      </group>

      {/* Fire escape */}
      <group position={[45,0,-22]}>
        {[2,8].map((py,i)=><mesh key={i} position={[0,py,0]}><boxGeometry args={[4,0.18,5.5]} /><meshStandardMaterial color="#141618" roughness={0.9} metalness={0.3} /></mesh>)}
        {[-1.8,1.8].map((rx,i)=><mesh key={i} position={[rx,5.1,2.5]} rotation={[0.18,0,0]}><boxGeometry args={[0.1,7,0.1]} /><meshStandardMaterial color="#1e2025" /></mesh>)}
        {[0,1,2,3,4,5].map((_,i)=><mesh key={i} position={[0,2.8+i,2.5]} rotation={[0.18,0,0]}><boxGeometry args={[3.6,0.07,0.5]} /><meshStandardMaterial color="#111" /></mesh>)}
      </group>

      {/* Roof hatch */}
      <group position={[-30,0,-10]}>
        <mesh position={[0,0.4,0]}><boxGeometry args={[4,0.8,3]} /><meshStandardMaterial color="#232528" roughness={0.9} /></mesh>
        <mesh position={[0,0.81,0]} rotation={[-0.4,0,0]}><boxGeometry args={[3.6,0.1,2.8]} /><meshStandardMaterial color="#1a1c20" roughness={0.5} metalness={0.3} /></mesh>
      </group>

      {/* Debris */}
      {([[5,-6],[-9,-20],[14,22],[-20,8],[32,-15],[-8,30]] as [number,number][]).map(([dx,dz],i)=>(
        <mesh key={i} position={[dx,0.15,dz]} rotation={[0,i*0.7,0]}>
          <boxGeometry args={[0.4+i*0.08,0.3,0.3+i*0.06]} />
          <meshStandardMaterial color="#1a1c20" roughness={0.97} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Puddle ripples ───────────────────────────────────────────────────────────
function PuddleRipples() {
  const PUDDLES: [number, number, number][] = [
    [3,6,0.4], [-7,-12,0.55], [12,-8,0.3], [-14,15,0.5],
    [20,3,0.45], [-3,-28,0.5], [8,-30,0.35],
  ];
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLightning: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uLightning;
      varying vec2 vUv;
      void main() {
        vec2  uv = vUv - 0.5;
        float d  = length(uv) * 2.0;
        if (d > 1.0) discard;
        float ring = 0.0;
        for (int i = 0; i < 4; i++) {
          float phase = fract(uTime * 0.42 + float(i) * 0.25);
          float r     = phase * 0.94;
          float w     = 0.020 + phase * 0.016;
          ring += (1.0 - smoothstep(0.0, w, abs(d - r))) * (1.0 - phase);
        }
        float alpha = ring * (1.0 - smoothstep(0.62, 1.0, d)) * 0.52;
        if (alpha < 0.004) discard;
        float lit = 1.0 + uLightning * 3.5;
        gl_FragColor = vec4(
          min(0.56 * lit, 1.0),
          min(0.72 * lit, 1.0),
          min(0.90 * lit, 1.0),
          min(alpha * (1.0 + uLightning * 1.8), 1.0)
        );
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), []);

  useFrame((_, dt) => {
    mat.uniforms.uTime.value      += dt;
    mat.uniforms.uLightning.value  = W.lightning;
  });

  return (
    <group>
      {PUDDLES.map(([px, pz, sc], i) => (
        <mesh key={i} position={[px, 0.04, pz]} rotation={[-Math.PI/2, 0, 0]} material={mat}>
          <circleGeometry args={[3 * sc + 1.5, 32]} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Thin water film flowing across rooftop ───────────────────────────────────
function WaterFlow() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLightning: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uLightning;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i),              hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
      }
      void main() {
        vec2  flow  = vec2(0.038, 0.055);
        float n1    = noise(vUv * 9.0  + flow * uTime);
        float n2    = noise(vUv * 6.0  + flow * uTime * 0.65 + vec2(1.7, 0.9));
        float riv   = pow(abs(sin((vUv.x * 24.0 + vUv.y * 9.0 + uTime * 0.12) * 3.14159)), 9.0);
        float base  = n1 * n2 * 0.055 + riv * 0.040;
        float alpha = min(base * (1.0 + uLightning * 4.0), 0.95);
        if (alpha < 0.004) discard;
        float lit = 1.0 + uLightning * 2.8;
        gl_FragColor = vec4(min(0.50*lit,1.0), min(0.65*lit,1.0), min(0.85*lit,1.0), alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  useFrame((_, dt) => {
    mat.uniforms.uTime.value      += dt;
    mat.uniforms.uLightning.value  = W.lightning;
  });

  return (
    <mesh position={[0, 0.03, -20]} rotation={[-Math.PI/2, 0, 0]} material={mat}>
      <planeGeometry args={[118, 118]} />
    </mesh>
  );
}

// ─── Storm clouds — 3 FBM-noise horizontal layers, drifting ───────────────────
function makeCloudMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime:      { value: 0 },
      uDrift:     { value: 0.006 },
      uPhase:     { value: 0.55 },
      uLightning: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime; uniform float uDrift; uniform float uPhase; uniform float uLightning;
      varying vec2  vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x),
                   mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.55;
        for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.1 + vec2(1.7, 9.2); a *= 0.5; }
        return v;
      }
      void main() {
        vec2  uv    = vUv + vec2(uTime * uDrift, uTime * uDrift * 0.38);
        float n     = fbm(uv * 2.4);
        float n2    = fbm(uv * 5.1 + vec2(3.1, 1.9));
        float cloud = smoothstep(0.20, 0.88, n * n2 * 2.6);
        float alpha = cloud * uPhase * 0.82;
        if (alpha < 0.010) discard;
        float lit = 1.0 + uLightning * 1.8;
        vec3  col = mix(vec3(0.040, 0.050, 0.090), vec3(0.260, 0.280, 0.340), cloud * 0.55) * lit;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

function StormClouds() {
  const LAYERS = useMemo(() => [
    { y: 52, z: -130, w: 440, h: 200, drift: 0.0052 },
    { y: 68, z: -205, w: 530, h: 185, drift: 0.0034 },
    { y: 38, z:  -88, w: 370, h: 165, drift: 0.0071 },
  ], []);
  const mats = useMemo(() => LAYERS.map(l => {
    const m = makeCloudMat();
    m.uniforms.uDrift.value = l.drift;
    return m;
  }), [LAYERS]);

  useFrame((_, dt) => {
    mats.forEach(m => {
      m.uniforms.uTime.value      += dt;
      m.uniforms.uPhase.value      = W.phase;
      m.uniforms.uLightning.value  = W.lightning;
    });
  });

  return (
    <group>
      {LAYERS.map((l, i) => (
        <mesh key={i} position={[0, l.y, l.z]} rotation={[-Math.PI / 2, 0, 0]} material={mats[i]}>
          <planeGeometry args={[l.w, l.h]} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Building fog — noise planes at streetscape depths ────────────────────────
function BuildingFog() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPhase: { value: 0.55 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime; uniform float uPhase;
      varying vec2  vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x),
                   mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
      }
      void main() {
        vec2  uv  = vUv + vec2(uTime * 0.007, 0.0);
        float n   = noise(uv * 3.8) * noise(uv * 7.4 + vec2(1.3, 2.7));
        float fog = smoothstep(0.09, 0.55, n) * uPhase;
        float ey  = 1.0 - smoothstep(0.30, 0.50, abs(vUv.y - 0.5));
        float ex  = 1.0 - smoothstep(0.40, 0.50, abs(vUv.x - 0.5));
        float alpha = fog * ey * ex * 0.30;
        if (alpha < 0.006) discard;
        gl_FragColor = vec4(0.10, 0.13, 0.20, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  const PLANES: [number, number, number, number][] = [
    [13,  -92, 290, 48],
    [10, -150, 370, 40],
    [ 8, -215, 430, 34],
    [14, -280, 490, 28],
  ];

  useFrame((_, dt) => {
    mat.uniforms.uTime.value  += dt;
    mat.uniforms.uPhase.value  = W.phase;
  });

  return (
    <group>
      {PLANES.map(([y, z, w, h], i) => (
        <mesh key={i} position={[0, y, z]} material={mat}>
          <planeGeometry args={[w, h]} />
        </mesh>
      ))}
    </group>
  );
}

// ─── Rooftop mist — low drifting veil across the concrete floor ───────────────
function RooftopMist() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPhase: { value: 0.55 }, uLightning: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime; uniform float uPhase; uniform float uLightning;
      varying vec2  vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x),
                   mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
      }
      void main() {
        vec2  uv   = vUv + vec2(uTime * 0.020, uTime * 0.013);
        float n1   = noise(uv * 4.5);
        float n2   = noise(uv * 9.0 + vec2(2.1, 3.7));
        float mist = smoothstep(0.18, 0.82, n1 * n2 * 2.4);
        float alpha = mist * uPhase * 0.40 * (1.0 + uLightning * 1.6);
        if (alpha < 0.007) discard;
        gl_FragColor = vec4(0.80, 0.86, 0.96, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  }), []);

  useFrame((_, dt) => {
    mat.uniforms.uTime.value      += dt;
    mat.uniforms.uPhase.value      = W.phase;
    mat.uniforms.uLightning.value  = W.lightning;
  });

  return (
    <mesh position={[0, 1.5, -20]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
      <planeGeometry args={[130, 130]} />
    </mesh>
  );
}

// ─── Dynamic weather controller — timing, lightning lights, all sub-effects ───
function DynamicWeather() {
  const ambRef  = useRef<THREE.AmbientLight>(null);
  const ptRef   = useRef<THREE.PointLight>(null);
  const strikeT = useRef(0.0);
  const active  = useRef(false);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;

    // Weather phase: dual-frequency sine → 0 = calm, 1 = full storm (~13-min cycle)
    const raw = 0.52 + 0.40 * Math.sin(t * 0.0121) + 0.08 * Math.sin(t * 0.0313 + 1.1);
    W.phase   = Math.max(0.0, Math.min(1.0, raw));

    // Lightning countdown
    W._nextStrike -= dt;
    if (W._nextStrike <= 0 && !active.current) {
      active.current  = true;
      strikeT.current = 0.0;
      // Rare at calm (up to ~36 s), frequent at peak storm (as short as 4 s)
      W._nextStrike = 4.0 + (1.0 - W.phase) * 28.0 + Math.random() * 8.0;
    }

    // Flash envelope: instant spike → partial decay → secondary flash → tail off
    if (active.current) {
      strikeT.current += dt;
      const s = strikeT.current;
      let fl = 0.0;
      if      (s < 0.055) fl = s / 0.055;
      else if (s < 0.090) fl = 1.0 - (s - 0.055) / 0.035 * 0.55;
      else if (s < 0.130) fl = 0.45 + (s - 0.090) / 0.040 * 0.40;
      else if (s < 0.240) fl = 0.85 - (s - 0.130) / 0.110;
      else { fl = 0.0; active.current = false; }
      W.lightning = fl;
    } else {
      W.lightning = 0.0;
    }

    // Illuminate entire scene during strike
    if (ambRef.current) ambRef.current.intensity  = W.lightning * 4.5;
    if (ptRef.current)  ptRef.current.intensity   = W.lightning * 340.0;
  });

  return (
    <>
      <ambientLight ref={ambRef} color="#c8dcff" intensity={0} />
      <pointLight   ref={ptRef}  color="#d0e4ff" intensity={0}
                    position={[0, 240, -80]} distance={1000} decay={1.1} />
      <StormClouds />
      <BuildingFog />
      <RooftopMist />
      <PuddleRipples />
      <WaterFlow />
    </>
  );
}

// ─── Scene root ───────────────────────────────────────────────────────────────
export function RooftopScene() {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 1.5, ease: 'easeInOut' }}
      className="absolute inset-0"
    >
      <Canvas
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true }}
        camera={{ fov: 55, near: 0.5, far: 800 }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={['#03050a']} />
        <fogExp2 attach="fog" args={['#03050a', 0.011]} />

        <ambientLight intensity={0.18} color="#3355aa" />
        <directionalLight position={[60,80,30]} intensity={0.55} color="#99bbee" />
        <directionalLight position={[0,-10,0]} intensity={0.08} color="#221100" />

        <CameraRig />
        <AtmosphericHaze />
        <Rooftop />
        <Skyline />
        <DistantBillboards />
        <BuildingBlinkers />
        <Cars />
        <Aircraft />
        <Steam />
        <CinematicRain />
        <SplashParticles />
        <RoofDrips />
        <DynamicWeather />
      </Canvas>
    </motion.div>
  );
}
