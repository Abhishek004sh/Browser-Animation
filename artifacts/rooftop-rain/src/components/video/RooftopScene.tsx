import React, { useMemo, useRef, useEffect, Component, type ReactNode } from 'react';
import { Canvas, useFrame, extend, useThree, type ThreeElement } from '@react-three/fiber';
import gsap from 'gsap';
import * as THREE from 'three';
import { motion } from 'framer-motion';
import { shaderMaterial } from '@react-three/drei';
import { EffectComposer, Bloom, DepthOfField, Vignette, ChromaticAberration, Noise, HueSaturation } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { RooftopDetails } from './RooftopDetails';

// ─── Shader materials ──────────────────────────────────────────────────────────

const SteamMaterial = shaderMaterial(
  { uTime: 0 },
  `uniform float uTime; attribute float aPhase;
   varying float vAlpha;
   void main() {
     vec3 p = position;
     float t = fract(aPhase + uTime * 0.09);
     // Rise capped at 6 units so rooftop HVAC steam (emitters y≈1–4) peaks
     // below the billboard faces (y≈10–12) and never floats through them.
     float spread = t * t * 3.2;
     p.x += sin(uTime * 0.45 + aPhase * 7.3) * spread;
     p.y += t * 6.0;
     p.z += cos(uTime * 0.38 + aPhase * 5.8) * spread;
     gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
     vAlpha = max(0.0, 1.0 - t * t);
     gl_PointSize = max(1.5, vAlpha * 16.0);
   }`,
  `varying float vAlpha;
   void main() {
     vec2 uv = gl_PointCoord * 2.0 - 1.0;
     float r = length(uv);
     float a = (1.0 - smoothstep(0.28, 1.0, r)) * vAlpha * 0.30;
     if (a < 0.005) discard;
     gl_FragColor = vec4(0.80, 0.84, 0.94, a);
   }`
);

extend({ SteamMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    steamMaterial: ThreeElement<typeof SteamMaterial>;
  }
}

// ─── Module-level shared weather state (written by DynamicWeather, read by all) ─
// lightningPeak/lightningBounce/lightningDir* are additive fields for richer
// per-strike variety; existing consumers only ever read `lightning` and
// `phase`, so this extension is fully backward compatible.
const W = {
  phase: 0.55, lightning: 0.0, _nextStrike: 14.0,
  lightningPeak: 1.0, lightningBounce: 0.0,
  lightningDirX: 0, lightningDirY: 140, lightningDirZ: -20,
};

// ─── Building facade material — 5 archetypes, procedural detail ───────────────
// Attributes: aType (0-4 archetype), aPhase (per-building seed),
//             aBW (world width), aBH (world height)
function makeBuildingFacadeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLightning: { value: 0 } },
    vertexShader: `
      attribute float aType;
      attribute float aPhase;
      attribute float aBW;
      attribute float aBH;
      varying  vec2   vUv;
      varying  vec3   vNorm;
      varying  float  vType;
      varying  float  vPhase;
      varying  float  vBW;
      varying  float  vBH;
      void main() {
        vUv   = uv;
        vNorm = normal;
        vType  = aType;
        vPhase = aPhase;
        vBW    = aBW;
        vBH    = aBH;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uLightning;
      varying vec2  vUv;
      varying vec3  vNorm;
      varying float vType;
      varying float vPhase;
      varying float vBW;
      varying float vBH;

      float hash(float n) { return fract(sin(n) * 43758.5453); }

      void main() {
        int  type    = int(vType + 0.5);
        bool isTop   = vNorm.y > 0.5;
        bool isFront = abs(vNorm.z) > 0.5;

        // ── Archetype base color ────────────────────────────────────────
        // 0: glass curtain wall    — deep cool blue-gray
        // 1: brick residential     — warm dark terracotta-brown
        // 2: concrete / service    — muted gray-green
        // 3: modern steel          — dark near-neutral
        // 4: painted concrete      — slightly warmer gray
        vec3 baseCol;
        if      (type == 0) baseCol = vec3(0.052, 0.072, 0.118);
        else if (type == 1) baseCol = vec3(0.082, 0.056, 0.044);
        else if (type == 2) baseCol = vec3(0.058, 0.065, 0.060);
        else if (type == 3) baseCol = vec3(0.062, 0.070, 0.083);
        else                baseCol = vec3(0.075, 0.070, 0.064);

        // Per-building phase variation (±10%) so no two buildings are identical
        float pv  = 1.0 + (hash(vPhase * 17.3 + 1.7) - 0.5) * 0.20;
        vec3  col = baseCol * pv;

        if (!isTop) {
          // ── Horizontal floor separation bands ──────────────────────
          // One thin dark line per ~4.5-unit floor; creates a strong
          // architectural rhythm across the entire building height.
          float floorCount = max(4.0, vBH / 4.5);
          float fy = fract(vUv.y * floorCount);
          float floorLine  = 1.0 - smoothstep(0.0, 0.055, fy)
                                 * smoothstep(0.0, 0.055, 1.0 - fy);
          col *= 1.0 - floorLine * (type == 1 ? 0.22 : 0.13);

          // ── Vertical bay division lines ─────────────────────────────
          // Bay width varies by archetype to reflect real construction logic:
          // glass = 4.2 u (curtain modules), brick = 3.5 u, concrete = 5.5 u
          float bayW     = type == 2 ? 5.5 : (type == 1 ? 3.5 : 4.2);
          float colSpan  = isFront ? vBW : vBW * 0.68; // side faces narrower
          float bayCount = max(2.0, colSpan / bayW);
          float bx = fract(vUv.x * bayCount);
          float bayLine  = 1.0 - smoothstep(0.0, 0.045, bx)
                               * smoothstep(0.0, 0.045, 1.0 - bx);
          col *= 1.0 - bayLine * 0.09;

          // ── Corner darkening — shadow accumulates at building corners ─
          float crnX = 1.0 - smoothstep(0.0, 0.09, vUv.x)
                           * smoothstep(0.0, 0.09, 1.0 - vUv.x);
          col *= 1.0 - crnX * 0.34;

          // ── Thin specular edge highlight (moonlight on building edges) ──
          float eX = smoothstep(0.96, 1.00, vUv.x) + smoothstep(0.96, 1.00, 1.0 - vUv.x);
          float eY = smoothstep(0.98, 1.00, vUv.y) + smoothstep(0.98, 1.00, 1.0 - vUv.y);
          float edge = clamp(eX + eY, 0.0, 1.0);
          // Glass and steel read brighter on their edges
          float edgeBright = (type == 0 || type == 3) ? 0.15 : 0.06;
          col += vec3(edge * edgeBright);

          // ── Glass curtain wall: subtle vertical reflection banding ───
          if (type == 0) {
            float rb = 0.5 + 0.5 * sin(vUv.x * 13.7 + vPhase * 6.28);
            col += rb * rb * vec3(0.010, 0.013, 0.019);
          }

          // ── Brick: subtle horizontal mortar row texture ──────────────
          if (type == 1) {
            float rowV = fract(vUv.y * (vBH / 0.45));
            col *= 1.0 - smoothstep(0.90, 1.0, rowV) * 0.08;
          }

          // ── Recessed window band — slight shadow inside reveal ───────
          float floorMid = 0.5 + 0.5 * sin(fy * 3.14159);
          float winDepth = smoothstep(0.12, 0.62, floorMid)
                         * smoothstep(0.12, 0.62, 1.0 - floorMid);
          col *= 1.0 - winDepth * 0.06;

          // ── Rain-wet base: moisture darkens bottom ~18% of facade ────
          col *= 1.0 - smoothstep(0.0, 0.18, vUv.y) * 0.26;
        }

        // ── Indirect city glow: warm uplight from street level ──────────
        float cityGlow = 0.020 * (1.0 - vUv.y);
        col += vec3(cityGlow, cityGlow * 0.50, cityGlow * 0.16);

        // ── Lightning flash: faint cool wash across all surfaces ─────────
        col += vec3(uLightning * 0.040, uLightning * 0.048, uLightning * 0.068);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.FrontSide,
  });
}

// ─── Floor-pattern window material — archetype-aware occupancy ────────────────
// aFloorType: 0=dark  1=office  2=residential  3=emergency  4=blinds
// Floors of the same type use per-window aPhase for individual variation
// so patterns look structured (floor-based) but not robotic.
function makeFloorWindowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLightning: { value: 0 } },
    vertexShader: `
      attribute float aFloorType;
      attribute float aPhase;
      attribute vec3  aColor;
      uniform  float  uTime;
      uniform  float  uLightning;
      varying  vec3   vCol;
      void main() {
        float ft    = aFloorType;
        float speed = 0.04 + aPhase * 0.10;

        if (ft < 0.5) {
          // Dark floor — nearly all off; rare security light stays on
          float secOn = step(0.96, fract(aPhase * 31.7));
          vCol = vec3(0.20, 0.12, 0.06) * 0.14 * secOn;

        } else if (ft < 1.5) {
          // Office — neutral-warm white, 80% on, very gentle flicker
          float wave  = 0.90 + 0.10 * sin(uTime * speed + aPhase * 6.28);
          float onOff = step(0.20, fract(aPhase * 7.389));
          float flick = step(0.988, fract(aPhase * 31.4 + uTime * (0.04 + aPhase * 0.06)));
          float lit   = wave * max(onOff, flick) * (1.0 + uLightning * 0.13);
          vCol = aColor * lit * 1.10;

        } else if (ft < 2.5) {
          // Residential — warm amber, ~50% on, slow organic variation
          float wave  = 0.65 + 0.35 * sin(uTime * speed * 0.45 + aPhase * 6.28);
          float onOff = step(0.50, fract(aPhase * 7.389));
          vCol = aColor * wave * onOff * 1.00 * (1.0 + uLightning * 0.09);

        } else if (ft < 3.5) {
          // Emergency — dim steady red, always on
          vCol = vec3(0.52, 0.04, 0.02) * 0.48;

        } else {
          // Blinds / curtain — soft diffuse warm glow, 40% probability
          float glow  = 0.26 + 0.16 * sin(uTime * speed * 0.28 + aPhase * 6.28);
          float onOff = step(0.60, fract(aPhase * 7.389));
          vCol = vec3(0.76, 0.48, 0.18) * glow * onOff;
        }

        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
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
//
// Cinematic sequence (120 s seamless loop):
//   Phase 1 ( 0–45 s) — wide establishing shot dollies in toward rooftop
//   Phase 2 (45–68 s) — arc sweep to the right at medium height
//   Phase 3 (68–90 s) — gentle sweep back left, slightly lower
//   Phase 4 (90–120s) — slow pull back to wide establishing position (→ seamless loop)
//
// Breathing is a tiny ±0.07 u oscillation layered on top of the GSAP target —
// independent from the main timeline so it never resets on loop.
//
function CameraRig() {
  // Plain objects mutated by GSAP — no React re-renders needed
  const pos    = useRef({ x: 0,    y: 28, z: 65 }); // start = wide establishing shot
  const breath = useRef({ x: 0,    y: 0,  z: 0  }); // handheld micro-movement

  useEffect(() => {
    // ── Main cinematic timeline ──────────────────────────────────────────────
    const tl = gsap.timeline({ repeat: -1 });

    // Phase 1: dolly in from wide to mid-close (0 → 45 s)
    tl.to(pos.current, {
      x: 6, y: 14, z: 22,
      duration: 45, ease: 'power2.inOut',
    }, 0);

    // Phase 2: arc right to a three-quarter angle (45 → 68 s)
    // Narrower swing + slightly higher vantage keeps the rooftop deck framed
    // instead of grazing out toward the distant skyline ring.
    tl.to(pos.current, {
      x: 14, y: 12, z: 6,
      duration: 23, ease: 'power2.inOut',
    }, 45);

    // Phase 3: sweep back left, low orbit (68 → 90 s)
    tl.to(pos.current, {
      x: -10, y: 13, z: 9,
      duration: 22, ease: 'power2.inOut',
    }, 68);

    // Phase 4: pull back wide — returns to start for seamless loop (90 → 120 s)
    tl.to(pos.current, {
      x: 0, y: 28, z: 65,
      duration: 30, ease: 'power2.inOut',
    }, 90);

    // ── Handheld breathing — two out-of-phase oscillations ──────────────────
    // X/Y axis: slow gentle sway
    const b1 = gsap.to(breath.current, {
      x: 0.07, y: 0.05,
      duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1,
    });
    // Z axis: subtle push/pull
    const b2 = gsap.to(breath.current, {
      z: 0.06,
      duration: 4.7, ease: 'sine.inOut', yoyo: true, repeat: -1,
    });

    return () => { tl.kill(); b1.kill(); b2.kill(); };
  }, []);

  useFrame((state) => {
    const p = pos.current;
    const b = breath.current;
    state.camera.position.set(p.x + b.x, p.y + b.y, p.z + b.z);
    // Pulled the look-at target forward from the far skyline (-45) toward the
    // rooftop's own mid-depth so the deck stays the compositional anchor.
    state.camera.lookAt(0, 2.4, -30);
  });

  return null;
}

// ─── Cinematic Rain — GPU particle system ────────────────────────────────────

function makeFarRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWindX: { value: 0 }, uWindZ: { value: 0 }, uLightning: { value: 0 } },
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
        // Softened far-rain alpha (0.30 → 0.22) so distant drops read as mist,
        // not a wall of bright streaks.
        vAlpha = (1.0 - clamp((dist - 10.0) / 150.0, 0.0, 1.0) * 0.8) * 0.22;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      uniform float uLightning;
      void main() {
        vec2  uv    = gl_PointCoord * 2.0 - 1.0;
        float d     = length(uv * vec2(3.2, 1.0));
        // Rain becomes very slightly more visible during a flash, like it's
        // briefly catching the light — reverts the instant the flash decays.
        float alpha = (1.0 - smoothstep(0.1, 1.0, d)) * vAlpha * (1.0 + uLightning * 0.35);
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(0.40, 0.51, 0.66, alpha);
      }
    `,
    transparent: true, depthWrite: false,
  });
}

function makeNearRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uWindX: { value: 0 }, uWindZ: { value: 0 }, uLightning: { value: 0 } },
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
        // Overall near-rain alpha trimmed 20% (×0.8) so drops feel like rain,
        // not opaque white streaks slicing the frame.
        vAlpha = (1.0 - clamp((dist - 4.0) / 100.0, 0.0, 1.0) * 0.75) * 0.8;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      uniform float uLightning;
      void main() {
        vec2  uv      = gl_PointCoord * 2.0 - 1.0;
        // Streak: narrow in x, bright head (uv.y=-1) fading to tail (uv.y=+1)
        float xNarrow = 1.0 - smoothstep(0.0, 1.0, abs(uv.x) * 5.5);
        float yFade   = 1.0 - smoothstep(-0.95, 1.15, uv.y);
        float streak  = xNarrow * yFade;
        // Specular core at the head — weight reduced so the head no longer
        // reads as a hot white dot on top of each streak.
        float core    = 1.0 - smoothstep(0.0, 1.0, length(uv * vec2(8.5, 2.0)));
        // Rain briefly reads a touch brighter during a flash, then settles back.
        float alpha   = (streak * 0.55 + core * 0.30) * vAlpha * (1.0 + uLightning * 0.30);
        if (alpha < 0.004) discard;
        // Cooler, less pure-white blend — natural rain-drop tint instead of
        // bright white streaks.
        gl_FragColor  = vec4(mix(vec3(0.48, 0.62, 0.82), vec3(0.78, 0.85, 0.95), core * 0.35), alpha);
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
      m.uniforms.uTime.value      += dt;
      m.uniforms.uWindX.value      = wx;
      m.uniforms.uWindZ.value      = wz;
      m.uniforms.uLightning.value  = W.lightning;
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

// ─── Skyline rooftop micro-details — tanks, HVAC, antennas, maintenance lights ─
function SkylineRooftopDetails({ tops }: { tops: [number, number, number][] }) {
  const { tankMat, hvacMat, antMat, mlightMat, tanks, hvacs, ants, mlights } = useMemo(() => {
    const tankMat   = new THREE.MeshStandardMaterial({ color: '#2e2418', roughness: 0.93, metalness: 0.05 });
    const hvacMat   = new THREE.MeshStandardMaterial({ color: '#25282f', roughness: 0.78, metalness: 0.46 });
    const antMat    = new THREE.MeshStandardMaterial({ color: '#484848', metalness: 0.72, roughness: 0.50 });
    const mlightMat = new THREE.MeshBasicMaterial({ color: '#ff3030', toneMapped: false });
    const tanks:   THREE.Matrix4[] = [];
    const hvacs:   THREE.Matrix4[] = [];
    const ants:    THREE.Matrix4[] = [];
    const mlights: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();

    tops.forEach(([bx, bh, bz], i) => {
      if (bh < 35) return; // skip very short buildings — details too small to see
      // Deterministic hashes so layout is stable across re-renders
      const h1 = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const r1  = h1 - Math.floor(h1);
      const h2 = Math.sin(i * 83.3  +  17.1) * 43758.5453;
      const r2  = h2 - Math.floor(h2);
      const ox = (r1 - 0.5) * 5.0;
      const oz = (r2 - 0.5) * 5.0;

      if (r1 < 0.24 && tanks.length < 72) {
        // Wooden water tank (cylinder)
        dummy.position.set(bx + ox, bh + 3.5, bz + oz);
        dummy.scale.set(2.0, 4.0, 2.0);
        dummy.updateMatrix();
        tanks.push(dummy.matrix.clone());
      } else if (r1 < 0.52 && hvacs.length < 95) {
        // HVAC box
        dummy.position.set(bx + ox * 0.7, bh + 1.2, bz + oz * 0.7);
        dummy.scale.set(3.4, 1.9, 2.4);
        dummy.updateMatrix();
        hvacs.push(dummy.matrix.clone());
      } else if (r1 < 0.80 && ants.length < 115) {
        // Antenna / communication mast
        const ah = 3.0 + r2 * 9.0;
        dummy.position.set(bx + ox * 0.4, bh + ah * 0.5, bz + oz * 0.4);
        dummy.scale.set(0.14, ah, 0.14);
        dummy.updateMatrix();
        ants.push(dummy.matrix.clone());
        // Red aviation maintenance light at mast tip
        dummy.position.set(bx + ox * 0.4, bh + ah + 0.30, bz + oz * 0.4);
        dummy.scale.setScalar(0.24);
        dummy.updateMatrix();
        mlights.push(dummy.matrix.clone());
      }
    });

    return { tankMat, hvacMat, antMat, mlightMat, tanks, hvacs, ants, mlights };
  }, [tops]);

  const tankRef   = useRef<THREE.InstancedMesh>(null);
  const hvacRef   = useRef<THREE.InstancedMesh>(null);
  const antRef    = useRef<THREE.InstancedMesh>(null);
  const mlRef     = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    if (tankRef.current && tanks.length > 0) {
      tanks.forEach((m, i) => tankRef.current!.setMatrixAt(i, m));
      tankRef.current.instanceMatrix.needsUpdate = true;
    }
    if (hvacRef.current && hvacs.length > 0) {
      hvacs.forEach((m, i) => hvacRef.current!.setMatrixAt(i, m));
      hvacRef.current.instanceMatrix.needsUpdate = true;
    }
    if (antRef.current && ants.length > 0) {
      ants.forEach((m, i) => antRef.current!.setMatrixAt(i, m));
      antRef.current.instanceMatrix.needsUpdate = true;
    }
    if (mlRef.current && mlights.length > 0) {
      mlights.forEach((m, i) => mlRef.current!.setMatrixAt(i, m));
      mlRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [tanks, hvacs, ants, mlights]);

  return (
    <group>
      {tanks.length > 0 && (
        <instancedMesh ref={tankRef} args={[undefined, undefined, tanks.length]} material={tankMat}>
          <cylinderGeometry args={[0.5, 0.5, 1, 10]} />
        </instancedMesh>
      )}
      {hvacs.length > 0 && (
        <instancedMesh ref={hvacRef} args={[undefined, undefined, hvacs.length]} material={hvacMat}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}
      {ants.length > 0 && (
        <instancedMesh ref={antRef} args={[undefined, undefined, ants.length]} material={antMat}>
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}
      {mlights.length > 0 && (
        <instancedMesh ref={mlRef} args={[undefined, undefined, mlights.length]} material={mlightMat}>
          <sphereGeometry args={[1, 6, 4]} />
        </instancedMesh>
      )}
    </group>
  );
}

// ─── Skyline — 220 buildings + floor-pattern windows + rooftop details ─────────
function Skyline() {
  const BUILD_COUNT = 220;

  const buildData = useMemo(() => {
    const bMat:        THREE.Matrix4[]          = [];
    const wMat:        THREE.Matrix4[]          = [];
    const wColors:     THREE.Color[]            = [];
    const bTypes:      number[]                 = [];
    const bPhases:     number[]                 = [];
    const bWidths:     number[]                 = [];
    const bHeights:    number[]                 = [];
    const wFloorTypes: number[]                 = [];
    const wPhases:     number[]                 = [];
    const tops:        [number, number, number][] = [];

    const dummy = new THREE.Object3D();
    const c     = new THREE.Color();

    // Window color palettes per floor type
    // Office: neutral-warm white mix (3500–5000 K fluorescent / LED)
    const officeColors = ['#ffe8c0', '#fff0d8', '#f0f0e8', '#e8ecf0'];
    // Residential: warm amber (2700–3200 K incandescent / warm LED)
    const residColors  = ['#ffaa50', '#ffb860', '#ffc070', '#ffaa40'];

    // Archetype cumulative probability:
    //   0 glass(20%) | 1 brick(30%) | 2 concrete(20%) | 3 steel(15%) | 4 painted(15%)
    const typeThresh = [0.20, 0.50, 0.70, 0.85, 1.00];

    for (let i = 0; i < BUILD_COUNT; i++) {
      const ring  = Math.floor(i / 22);
      const angle = (i % 22) * (Math.PI * 2 / 22) + ring * 0.4;
      const rad   = 55 + ring * 28 + Math.random() * 18;
      const bx    = Math.cos(angle) * rad + (Math.random() - 0.5) * 20;
      const bz    = -80 + Math.sin(angle) * rad * 0.45 + (Math.random() - 0.5) * 15;
      const bw    = 8  + Math.random() * 28;
      const bd    = 8  + Math.random() * 28;
      const bh    = 25 + Math.random() * 220;

      // Assign archetype
      const bRoll  = Math.random();
      const bType  = Math.max(0, typeThresh.findIndex(t => bRoll < t));
      const bPhase = Math.random();

      dummy.position.set(bx, bh / 2, bz);
      dummy.scale.set(bw, bh, bd);
      dummy.updateMatrix();
      bMat.push(dummy.matrix.clone());
      bTypes.push(bType);
      bPhases.push(bPhase);
      bWidths.push(bw);
      bHeights.push(bh);
      tops.push([bx, bh, bz]);

      // Window grid on front face — aligned to facade floor bands and bay divisions.
      // FLOOR_H matches the facade shader's bH/4.5 floor count so windows sit at
      // the visual midpoint of each horizontal band. BAY_W matches the facade
      // shader's per-archetype bay spacing so columns align with vertical divisions.
      const frontZ  = bz + bd / 2 + 0.2;
      const FLOOR_H = 4.5;
      const BAY_W   = bType === 2 ? 5.5 : bType === 1 ? 3.5 : 4.2;
      const rows    = Math.max(2, Math.floor(bh / FLOOR_H));
      const cols    = Math.max(2, Math.floor(bw / BAY_W));
      const stepY   = FLOOR_H;
      const stepX   = bw / cols;

      // Per-building floor-occupancy seed (deterministic, stable)
      const floorSeed = bPhase * 997.3;

      for (let r = 0; r < rows; r++) {
        // Deterministic floor personality — same result every render
        const fh  = Math.sin(floorSeed + r * 2.399) * 43758.5453;
        const fv  = fh - Math.floor(fh);

        let floorType: number;
        if      (fv < 0.45) floorType = 0; // dark         45%
        else if (fv < 0.73) floorType = 1; // office       28%
        else if (fv < 0.91) floorType = 2; // residential  18%
        else if (fv < 0.99) floorType = 4; // blinds        8%
        else                floorType = 3; // emergency     1%

        // Architectural overrides
        if (bType === 0 && r >= rows - 2)          floorType = 1; // glass top floors always lit
        if ((bType === 1 || bType === 4) && r === 0) floorType = 1; // retail ground floor

        for (let col = 0; col < cols; col++) {
          // Dark floors: almost no windows placed (saves draw count)
          if (floorType === 0 && Math.random() > 0.06) continue;
          // Standard density for lit floors
          if (Math.random() > 0.62) continue;

          dummy.position.set(
            bx - bw / 2 + stepX * (col + 0.5), // center of bay column
            (r + 0.5) * stepY,                  // center of floor band
            frontZ,
          );
          dummy.scale.set(
            Math.min(stepX * 0.52, 2.8),         // window width within bay
            Math.min(stepY * 0.52, 2.6),         // window height within floor band
            1,
          );
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          wMat.push(dummy.matrix.clone());

          wFloorTypes.push(floorType);
          wPhases.push(Math.random());

          if (floorType === 1) {
            c.set(officeColors[Math.floor(Math.random() * officeColors.length)]);
          } else if (floorType === 2) {
            c.set(residColors[Math.floor(Math.random() * residColors.length)]);
          } else {
            c.set('#ffffff');
          }
          wColors.push(c.clone());
        }
      }
    }

    return { bMat, wMat, wColors, bTypes, bPhases, bWidths, bHeights, wFloorTypes, wPhases, tops };
  }, []);

  const facadeMat = useMemo(() => makeBuildingFacadeMaterial(), []);
  const windowMat = useMemo(() => makeFloorWindowMaterial(), []);
  const buildRef  = useRef<THREE.InstancedMesh>(null);
  const windowRef = useRef<THREE.InstancedMesh>(null);

  // Upload per-instance building facade attributes
  useEffect(() => {
    if (!buildRef.current) return;
    const { bMat, bTypes, bPhases, bWidths, bHeights } = buildData;
    const n = bMat.length;
    bMat.forEach((m, i) => buildRef.current!.setMatrixAt(i, m));
    buildRef.current.instanceMatrix.needsUpdate = true;

    const aType  = new Float32Array(n);
    const aPhase = new Float32Array(n);
    const aBW    = new Float32Array(n);
    const aBH    = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      aType[i]  = bTypes[i];
      aPhase[i] = bPhases[i];
      aBW[i]    = bWidths[i];
      aBH[i]    = bHeights[i];
    }
    buildRef.current.geometry.setAttribute('aType',  new THREE.InstancedBufferAttribute(aType,  1));
    buildRef.current.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
    buildRef.current.geometry.setAttribute('aBW',    new THREE.InstancedBufferAttribute(aBW,    1));
    buildRef.current.geometry.setAttribute('aBH',    new THREE.InstancedBufferAttribute(aBH,    1));
  }, [buildData]);

  // Upload per-instance window floor-type attributes
  useEffect(() => {
    if (!windowRef.current) return;
    const { wMat, wColors, wFloorTypes, wPhases } = buildData;
    const n = wMat.length;
    wMat.forEach((m, i) => windowRef.current!.setMatrixAt(i, m));
    windowRef.current.instanceMatrix.needsUpdate = true;

    const aFloorType = new Float32Array(n);
    const aPhase     = new Float32Array(n);
    const aColor     = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      aFloorType[i]    = wFloorTypes[i];
      aPhase[i]        = wPhases[i];
      aColor[i * 3]    = wColors[i].r;
      aColor[i * 3 + 1] = wColors[i].g;
      aColor[i * 3 + 2] = wColors[i].b;
    }
    windowRef.current.geometry.setAttribute('aFloorType', new THREE.InstancedBufferAttribute(aFloorType, 1));
    windowRef.current.geometry.setAttribute('aPhase',     new THREE.InstancedBufferAttribute(aPhase,     1));
    windowRef.current.geometry.setAttribute('aColor',     new THREE.InstancedBufferAttribute(aColor,     3));
  }, [buildData]);

  useFrame((_, dt) => {
    facadeMat.uniforms.uLightning.value  = W.lightning;
    windowMat.uniforms.uTime.value      += dt;
    windowMat.uniforms.uLightning.value  = W.lightning;
  });

  return (
    <group>
      <instancedMesh ref={buildRef} args={[undefined, undefined, BUILD_COUNT]} material={facadeMat}>
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      {buildData.wMat.length > 0 && (
        <instancedMesh
          ref={windowRef}
          args={[undefined, undefined, buildData.wMat.length]}
          material={windowMat}
        >
          <planeGeometry args={[1, 1]} />
        </instancedMesh>
      )}
      <SkylineRooftopDetails tops={buildData.tops} />
    </group>
  );
}

// ─── Streets — dark wet-asphalt road planes at car lanes ────────────────────
// Gives the moving car lights a physical surface to sit on and reflect from.
function Streets() {
  // East-west roads at z values matching Cars component
  const EW_Z = [-100, -128, -160, -192];
  // North-south roads at x values matching Cars component
  const NS_X = [-58, -8, 48, 98];
  return (
    <group>
      {/* E-W road lanes — long thin planes along X axis */}
      {EW_Z.map((z, i) => (
        <mesh key={`ew-${i}`} position={[0, 0.01, z]} rotation={[-Math.PI/2, 0, 0]}>
          <planeGeometry args={[420, 10]} />
          <meshStandardMaterial color="#0a0b0d" roughness={0.28} metalness={0.14} />
        </mesh>
      ))}
      {/* N-S road lanes — long thin planes along Z axis */}
      {NS_X.map((x, i) => (
        <mesh key={`ns-${i}`} position={[x, 0.01, -130]} rotation={[-Math.PI/2, 0, 0]}>
          <planeGeometry args={[10, 280]} />
          <meshStandardMaterial color="#0a0b0d" roughness={0.28} metalness={0.14} />
        </mesh>
      ))}
    </group>
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
      const offX = c.type==='EW' ? c.dir*2.2 : 0;
      const offZ = c.type==='NS' ? c.dir*2.2 : 0;
      // Flat ellipsoid lenses hugging the road surface (y≈0.35) — no floating balls
      dummy.position.set(c.x+offX, 0.35, c.z+offZ);
      dummy.scale.set(0.65, 0.18, 0.65);
      dummy.updateMatrix();
      headRef.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(c.x-offX*0.85, 0.35, c.z-offZ*0.85);
      dummy.scale.set(0.52, 0.15, 0.52);
      dummy.updateMatrix();
      tailRef.current!.setMatrixAt(i, dummy.matrix);
    });
    headRef.current.instanceMatrix.needsUpdate = true;
    tailRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {/* Headlights — warm white discs on road surface */}
      <instancedMesh ref={headRef} args={[undefined, undefined, N]}>
        <sphereGeometry args={[1, 6, 4]} />
        <meshBasicMaterial color="#fff4e0" toneMapped={false} />
      </instancedMesh>
      {/* Taillights — red discs on road surface */}
      <instancedMesh ref={tailRef} args={[undefined, undefined, N]}>
        <sphereGeometry args={[1, 6, 4]} />
        <meshBasicMaterial color="#ff1a00" toneMapped={false} />
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
      varying  vec2   vUv;
      void main() {
        float t     = 0.5 + 0.5 * sin(uTime * 0.22 + aPhase * 6.28318);
        float flick = step(0.94, fract(aPhase * 17.3 + uTime * (0.08 + aPhase * 0.12)));
        vCol = mix(aCol1, aCol2, max(t, flick));
        vUv  = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3  vCol;
      varying vec2  vUv;
      void main() {
        // LED pixel grid — coarse subdivisions create a real-screen look
        vec2 grid  = fract(vUv * vec2(28.0, 14.0));
        float gapX = smoothstep(0.88, 0.96, grid.x);
        float gapY = smoothstep(0.84, 0.94, grid.y);
        float cell = 1.0 - max(gapX, gapY) * 0.38;
        // Horizontal scan line — darker band drifts from top to bottom
        float scan = 1.0 - 0.14 * smoothstep(0.0, 0.06, fract(vUv.y * 22.0));
        // Vignette — edges fall off subtly so the screen doesn't look uniformly flat
        float vx   = 1.0 - smoothstep(0.36, 0.50, abs(vUv.x - 0.5));
        float vy   = 1.0 - smoothstep(0.38, 0.50, abs(vUv.y - 0.5));
        float vig  = 0.72 + 0.28 * vx * vy;
        gl_FragColor = vec4(vCol * cell * scan * vig, 1.0);
      }
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

  // Lightning wet-reflection refs — floor + puddle materials get a brief
  // emissive nudge during a flash (puddles more than dry concrete).
  const floorMatRef   = useRef<THREE.MeshStandardMaterial>(null);
  const puddleMatRefs = useRef<(THREE.MeshPhysicalMaterial | null)[]>([]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Wet-surface lightning reflections — puddles flash noticeably brighter
    // than the dry concrete floor for the same strike.
    const wetFlash = W.lightning * 1.6;
    for (const m of puddleMatRefs.current) { if (m) m.emissiveIntensity = wetFlash; }
    if (floorMatRef.current) floorMatRef.current.emissiveIntensity = W.lightning * 0.35;

    // Billboard 1: warm amber → orange → red cycle
    // Dimmed ~28% vs. prior pass so the toneMapped=false face no longer
    // slams the bloom threshold and washes out into a flat white-orange glow.
    // A very subtle lightning sympathy (×1 + up to 0.12) is layered on last
    // so the emissive face reacts naturally without overpowering its own cycle.
    if (bb1MatRef.current) {
      const p     = t * 0.35;
      const flash = 1.0 + W.lightning * 0.12;
      const r     = (0.78 + 0.22 * Math.sin(p)) * 0.72 * flash;
      const g     = (0.22 + 0.20 * Math.sin(p + 1.2)) * 0.72 * flash;
      bb1MatRef.current.color.setRGB(r, g, 0.02);
    }
    if (bb1LightRef.current && bb1MatRef.current) {
      bb1LightRef.current.color.copy(bb1MatRef.current.color);
      bb1LightRef.current.intensity = 1.4 + 0.5 * Math.sin(t * 0.35);
    }

    // Billboard 2: cyan → blue → teal cycle
    if (bb2MatRef.current) {
      const p     = t * 0.27 + 1.8;
      const flash = 1.0 + W.lightning * 0.12;
      const b     = (0.65 + 0.35 * Math.sin(p)) * 0.72 * flash;
      const g     = (0.38 + 0.30 * Math.sin(p + 0.9)) * 0.72 * flash;
      bb2MatRef.current.color.setRGB(0.02, g, b);
    }
    if (bb2LightRef.current && bb2MatRef.current) {
      bb2LightRef.current.color.copy(bb2MatRef.current.color);
      bb2LightRef.current.intensity = 1.2 + 0.4 * Math.sin(t * 0.27 + 1.8);
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
      {/* Concrete floor — rain-slicked surface: low roughness and slightly
          elevated metalness so headlights and city glow create visible
          specular smears across the wet deck. emissive is still only
          nudged during a lightning flash (see useFrame above). */}
      <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,-20]} receiveShadow>
        <planeGeometry args={[120,120]} />
        <meshStandardMaterial ref={floorMatRef} color="#161820" roughness={0.32} metalness={0.18} emissive="#8fa4c8" emissiveIntensity={0} />
      </mesh>

      {/* Ledges — cast soft shadows onto the deck */}
      <mesh castShadow position={[0,0.9,38]}><boxGeometry args={[120,1.8,1.2]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh castShadow position={[-59,0.9,-20]}><boxGeometry args={[1.2,1.8,120]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh castShadow position={[59,0.9,-20]}><boxGeometry args={[1.2,1.8,120]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>
      <mesh castShadow position={[0,0.9,-79]}><boxGeometry args={[120,1.8,1.2]} /><meshStandardMaterial color="#212328" roughness={0.95} /></mesh>

      {/* Puddles — emissive nudged up sharply during a lightning flash (see
          useFrame above) so wet reflections pop noticeably more than the
          dry concrete floor does for the same strike. */}
      {([[3,6,0.4],[-7,-12,0.55],[12,-8,0.3],[-14,15,0.5],[20,3,0.45],[-3,-28,0.5],[8,-30,0.35]] as [number,number,number][]).map(([px,pz,sc],i)=>(
        <mesh key={i} position={[px,0.02,pz]} rotation={[-Math.PI/2,0,0]}>
          <circleGeometry args={[3*sc+1.5,24]} />
          <meshPhysicalMaterial ref={(el) => { puddleMatRefs.current[i] = el; }} roughness={0.01} metalness={0.05} transmission={0.88} ior={1.33} transparent opacity={0.92} color="#1a1f2a" emissive="#dce8ff" emissiveIntensity={0} />
        </mesh>
      ))}

      {/* HVAC A — weathered galvanized steel, rain-streaked */}
      <group position={[-16,0,-14]}>
        <mesh position={[0,1.6,0]}><boxGeometry args={[7,3.2,5]} /><meshStandardMaterial color="#2a2e35" roughness={0.78} metalness={0.52} /></mesh>
        {/* Rust streak panels */}
        <mesh position={[1.2,1.0,2.52]} rotation={[0,0,0.06]}><planeGeometry args={[0.6,1.8]} /><meshStandardMaterial color="#3a2218" roughness={0.96} transparent opacity={0.55} /></mesh>
        <mesh position={[0,3.22,0]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[5,3.5]} /><meshStandardMaterial color="#0e1012" roughness={0.92} metalness={0.3} /></mesh>
        {[-1.5,-0.5,0.5,1.5].map((dx,i)=><mesh key={i} position={[dx,1.6,2.55]}><boxGeometry args={[0.08,2.6,0.12]} /><meshStandardMaterial color="#0e1014" metalness={0.55} roughness={0.6} /></mesh>)}
      </group>

      {/* HVAC B — slightly corroded housing */}
      <group position={[11,0,-5]}>
        <mesh position={[0,1.5,0]}><boxGeometry args={[5,3,4.5]} /><meshStandardMaterial color="#292d34" roughness={0.80} metalness={0.48} /></mesh>
        {/* Corner rust patch */}
        <mesh position={[-2.48,0.6,0]} rotation={[0,Math.PI/2,0]}><planeGeometry args={[1.2,1.0]} /><meshStandardMaterial color="#2e1a10" roughness={0.97} transparent opacity={0.50} /></mesh>
        {[-1,0,1].map((dx,i)=><mesh key={i} position={[dx,1.5,2.28]}><boxGeometry args={[0.07,2.4,0.1]} /><meshStandardMaterial color="#0d1012" metalness={0.55} roughness={0.62} /></mesh>)}
      </group>

      {/* HVAC C — older unit, heavier rust banding */}
      <group position={[25,0,-18]}>
        <mesh position={[0,1.2,0]}><boxGeometry args={[8,2.4,5]} /><meshStandardMaterial color="#2e333c" roughness={0.82} metalness={0.44} /></mesh>
        {/* Rust band at base */}
        <mesh position={[0,0.32,0]} rotation={[0,0,0]}><boxGeometry args={[8.02,0.60,5.02]} /><meshStandardMaterial color="#2a1808" roughness={0.97} metalness={0.1} transparent opacity={0.6} /></mesh>
        <mesh position={[0,2.42,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[1.2,1.6,24]} /><meshStandardMaterial color="#1a1c1f" metalness={0.55} roughness={0.58} side={THREE.DoubleSide} /></mesh>
      </group>

      {/* Water tank — weathered cedar staves + rusted metal bands */}
      <group position={[20,0,-28]}>
        {([[-2,-2],[2,-2],[-2,2],[2,2]] as [number,number][]).map(([lx,lz],i)=>(
          <mesh key={i} position={[lx,3.5,lz]}><cylinderGeometry args={[0.14,0.16,7,8]} /><meshStandardMaterial color="#282420" metalness={0.55} roughness={0.55} /></mesh>
        ))}
        {([[0,3.5,2,Math.PI/2,0,0],[0,3.5,-2,Math.PI/2,0,0],[-2,3.5,0,0,0,Math.PI/2],[2,3.5,0,0,0,Math.PI/2]] as number[][]).map(([x,y,z,rx,ry,rz],i)=>(
          <mesh key={i} position={[x,y,z]} rotation={[rx,ry,rz]}><cylinderGeometry args={[0.05,0.05,4,6]} /><meshStandardMaterial color="#282420" metalness={0.55} roughness={0.55} /></mesh>
        ))}
        {/* Aged cedar stave body — darker, slightly greenish from moisture */}
        <mesh position={[0,8,0]}><cylinderGeometry args={[2.4,2.6,5,18]} /><meshStandardMaterial color="#3d3326" roughness={0.94} metalness={0.04} /></mesh>
        {/* Rusted iron bands */}
        {[6,7.5,9,10.5].map((y,i)=><mesh key={i} position={[0,y,0]}><torusGeometry args={[2.55,0.10,8,24]} /><meshStandardMaterial color="#3a2210" metalness={0.65} roughness={0.62} /></mesh>)}
        {/* Conical roof — oxidized dark metal */}
        <mesh position={[0,11,0]}><coneGeometry args={[2.8,1.8,18]} /><meshStandardMaterial color="#222620" roughness={0.88} metalness={0.18} /></mesh>
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
        <pointLight ref={bb1LightRef} position={[0,12,6]} intensity={1.4} color="#ff6600" distance={60} decay={2} />
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
        <pointLight ref={bb2LightRef} position={[0,10,5]} intensity={1.2} color="#00ccff" distance={50} decay={2} />
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
        // Blend moonlight cool-blue with warm city bounce based on slow oscillation
        vec3 moon = vec3(0.56, 0.72, 0.90);
        vec3 city = vec3(0.85, 0.50, 0.20);
        float cityAmt = 0.28 + 0.22 * sin(uTime * 0.11);
        vec3 refl = mix(moon, city, cityAmt) * lit;
        gl_FragColor = vec4(
          min(refl.r, 1.0),
          min(refl.g, 1.0),
          min(refl.b, 1.0),
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
        // Water film reflects both moonlight and warm city glow
        vec3 moon = vec3(0.50, 0.65, 0.85);
        vec3 city = vec3(0.80, 0.48, 0.20);
        float cityAmt = 0.25 + 0.20 * sin(uTime * 0.09 + 1.3);
        vec3 col = mix(moon, city, cityAmt) * lit;
        gl_FragColor = vec4(min(col.r,1.0), min(col.g,1.0), min(col.b,1.0), alpha);
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
        // Warm city glow scatters into the lower fog banks; cool blue higher up
        float warmBlend = smoothstep(0.55, 0.12, vUv.y) * 0.50;
        vec3 fogCol = mix(vec3(0.10, 0.13, 0.20), vec3(0.22, 0.11, 0.06), warmBlend);
        gl_FragColor = vec4(fogCol, alpha);
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
// Extended in place (still one countdown → one active flag → one W.lightning
// output, same as before) to generate a randomized *sequence* of sub-pulses
// per strike instead of one hardcoded envelope, so no two strikes feel alike.
function DynamicWeather() {
  const ambRef    = useRef<THREE.AmbientLight>(null);
  const ptRef     = useRef<THREE.PointLight>(null);
  const dirRef    = useRef<THREE.DirectionalLight>(null);
  const bounceRef = useRef<THREE.PointLight>(null);
  const strikeT   = useRef(0.0);
  const active    = useRef(false);
  const bounce    = useRef(0.0);
  // Per-strike pulse plan: a list of {t0,t1,peak,phase} segments built once
  // when a strike starts, then simply sampled every frame while active.
  const pulses    = useRef<{ t0: number; t1: number; peak: number; phase: 'rise' | 'hold' | 'fall' }[]>([]);
  const totalDur  = useRef(0.24);

  useEffect(() => {
    // Aim the directional flash at the rooftop deck regardless of where in
    // the sky the strike originates each time.
    if (dirRef.current) {
      dirRef.current.target.position.set(0, 2, -30);
      dirRef.current.target.updateMatrixWorld();
    }
  }, []);

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

      // Build this strike's randomized pulse sequence: mostly single flashes,
      // occasionally a double, rarely a triple — each with its own randomized
      // intensity and rise/hold/fall timing so duration varies strike to strike.
      const roll        = Math.random();
      const flashCount  = roll < 0.65 ? 1 : roll < 0.87 ? 2 : 3;
      const strikePeak  = 0.70 + Math.random() * 0.55; // overall strike intensity, 0.70–1.25
      const seq: typeof pulses.current = [];
      let cursor = 0;
      for (let i = 0; i < flashCount; i++) {
        const riseDur   = 0.03 + Math.random() * 0.05;
        const holdDur   = 0.02 + Math.random() * 0.05;
        const fallDur   = 0.06 + Math.random() * 0.10;
        // Secondary/tertiary flashes in a multi-strike are usually a bit dimmer
        const flashPeak = strikePeak * (i === 0 ? 1.0 : 0.5 + Math.random() * 0.45);
        seq.push({ t0: cursor,               t1: cursor + riseDur,             peak: flashPeak, phase: 'rise' });
        cursor += riseDur;
        seq.push({ t0: cursor,               t1: cursor + holdDur,             peak: flashPeak, phase: 'hold' });
        cursor += holdDur;
        seq.push({ t0: cursor,               t1: cursor + fallDur,             peak: flashPeak, phase: 'fall' });
        cursor += fallDur;
        if (i < flashCount - 1) cursor += 0.05 + Math.random() * 0.09; // gap before next sub-flash
      }
      pulses.current   = seq;
      totalDur.current = cursor;
      W.lightningPeak  = strikePeak;

      // Randomize the flash's apparent origin high in the sky — a real strike
      // doesn't always come from directly overhead, so the subtle directional
      // light's angle (and therefore shadow/highlight side) varies each time.
      const az   = Math.random() * Math.PI * 2;
      const elev = 0.35 + Math.random() * 0.55;
      const dist = 90 + Math.random() * 70;
      W.lightningDirX = Math.cos(az) * dist;
      W.lightningDirY = 110 + elev * 160;
      W.lightningDirZ = -30 + Math.sin(az) * dist;
    }

    // Sample the current strike's pulse sequence (rise → hold → fall, possibly
    // repeated 2–3×) instead of one fixed hand-authored envelope.
    if (active.current) {
      strikeT.current += dt;
      const s = strikeT.current;
      let fl = 0.0;
      for (const seg of pulses.current) {
        if (s >= seg.t0 && s <= seg.t1) {
          const localT = (s - seg.t0) / Math.max(0.0001, seg.t1 - seg.t0);
          if      (seg.phase === 'rise') fl = seg.peak * localT;
          else if (seg.phase === 'hold') fl = seg.peak;
          else                           fl = seg.peak * (1.0 - localT);
          break;
        }
      }
      if (s > totalDur.current) { fl = 0.0; active.current = false; }
      W.lightning = fl;
    } else {
      W.lightning = 0.0;
    }

    // Soft ambient bounce — rises instantly with the flash but fades much more
    // slowly, giving a brief lingering glow across the rooftop after the strike.
    bounce.current    = Math.max(W.lightning * 0.6, bounce.current - dt * 1.1);
    W.lightningBounce = bounce.current;

    // Illuminate entire scene during strike
    if (ambRef.current) ambRef.current.intensity  = W.lightning * 4.5;
    if (ptRef.current)  ptRef.current.intensity   = W.lightning * 340.0;
    // Subtle directional component from the randomized sky origin
    if (dirRef.current) {
      dirRef.current.position.set(W.lightningDirX, W.lightningDirY, W.lightningDirZ);
      dirRef.current.intensity = W.lightning * 1.6;
    }
    // Trailing bounce light — cheap, no shadow, fades independently of the flash
    if (bounceRef.current) bounceRef.current.intensity = bounce.current * 5.0;
  });

  return (
    <>
      <ambientLight ref={ambRef} color="#c8dcff" intensity={0} />
      <pointLight   ref={ptRef}  color="#d0e4ff" intensity={0}
                    position={[0, 240, -80]} distance={1000} decay={1.1} />
      {/* Subtle directional flash — origin varies per strike; no shadow, cheap */}
      <directionalLight ref={dirRef} color="#dfe9ff" intensity={0} />
      {/* Soft ambient bounce that trails behind the sharp flash and fades slowly */}
      <pointLight ref={bounceRef} color="#b8c8e8" intensity={0}
                  position={[0, 14, -25]} distance={140} decay={1.6} />
      <StormClouds />
      <BuildingFog />
      <RooftopMist />
      <PuddleRipples />
      <WaterFlow />
    </>
  );
}

// ─── Characters — cinematic idle life ────────────────────────────────────────
//
// Each figure sits on the existing back ledge (z=-79, top y=1.8), legs
// hanging over the far side toward the city.  Idle motion uses two separate
// systems that never conflict:
//   • GSAP  → mutates a plain `idle` data object (non-repetitive random targets)
//   • useFrame → reads that data object + adds breathing & wind, writes to refs
//
// Only the Characters component and its helpers below are new.
// Nothing above this line is touched.
//

// Schedules one GSAP tween targeting a plain-object key, then reschedules
// itself on completion — producing genuinely non-repetitive idle drift.
function scheduleIdle(
  obj:      Record<string, number>,
  key:      string,
  range:    number,
  minDur:   number,
  maxDur:   number,
  minDelay: number,
  maxDelay: number,
  alive:    { v: boolean },
) {
  if (!alive.v) return;
  gsap.to(obj, {
    [key]:    (Math.random() - 0.5) * 2 * range,
    duration: minDur + Math.random() * (maxDur - minDur),
    delay:    minDelay + Math.random() * (maxDelay - minDelay),
    ease:     'power2.inOut',
    onComplete() { scheduleIdle(obj, key, range, minDur, maxDur, minDelay, maxDelay, alive); },
  });
}

function CharacterFigure({
  posX, isWoman, breathPhase,
}: { posX: number; isWoman: boolean; breathPhase: number }) {

  // Three.js group refs — never touched by GSAP directly
  const rootRef  = useRef<THREE.Group>(null);
  const torsoRef = useRef<THREE.Group>(null);
  const headRef  = useRef<THREE.Group>(null);
  const hairRef  = useRef<THREE.Group>(null);
  const lArmRef  = useRef<THREE.Group>(null);
  const rArmRef  = useRef<THREE.Group>(null);
  const lHndRef  = useRef<THREE.Group>(null);
  const rHndRef  = useRef<THREE.Group>(null);

  // Plain data object — GSAP writes here, useFrame reads here
  const idle = useRef<Record<string, number>>({
    headX: 0, headY: 0, headZ: 0,
    torsoY: 0, torsoZ: 0, torsoOfsY: 0,
    lArmZ: 0, rArmZ: 0,
    lHndZ: 0, rHndZ: 0,
    rootOfsY: 0,
  });

  useEffect(() => {
    const alive = { v: true };
    const id    = idle.current;

    // [key, range, minDur, maxDur, minDelay, maxDelay]
    // Staggered starts ensure the figure doesn't move all parts simultaneously.
    const cfg: [string, number, number, number, number, number, number][] = [
      ['headX',    0.040, 1.5, 4.0, 1.0, 5.0, 0.0],
      ['headY',    0.080, 2.0, 5.5, 1.5, 6.5, 0.6],
      ['headZ',    0.025, 2.5, 6.0, 2.0, 7.5, 1.1],
      ['torsoY',   0.055, 3.0, 7.5, 2.0, 8.5, 1.5],
      ['torsoZ',   0.032, 3.5, 7.0, 2.5, 9.0, 2.0],
      ['torsoOfsY',0.045, 4.0, 9.0, 3.0, 9.5, 2.8],
      ['lArmZ',    0.060, 2.0, 5.0, 1.0, 6.0, 0.4],
      ['rArmZ',    0.060, 2.0, 5.0, 1.5, 6.5, 0.9],
      ['lHndZ',    0.050, 1.5, 3.5, 2.0, 7.5, 1.8],
      ['rHndZ',    0.050, 1.5, 3.5, 2.5, 8.0, 2.3],
      ['rootOfsY', 0.030, 5.0,11.0, 4.0,10.0, 3.5],
    ];

    cfg.forEach(([key, range, mn, mx, dMn, dMx, start]) => {
      setTimeout(
        () => scheduleIdle(id, key, range, mn, mx, dMn, dMx, alive),
        (start + Math.random() * 1.5) * 1000,
      );
    });

    return () => {
      alive.v = false;
      gsap.killTweensOf(id);
    };
  }, []);

  useFrame((state) => {
    const t  = state.clock.elapsedTime;
    const id = idle.current;

    // Wind signal — mirrors rain shader's sine-wave wind
    const windX = Math.sin(t * 0.43) * 0.28 + Math.sin(t * 0.71 + 1.3) * 0.12;

    // ── Breathing ────────────────────────────────────────────────────────────
    const rate   = isWoman ? 1.05 : 0.88;
    const breathe = Math.sin(t * rate + breathPhase);

    if (torsoRef.current) {
      torsoRef.current.scale.y      = 1.0 + breathe * 0.011;
      torsoRef.current.position.y   = 2.58 + id.torsoOfsY + breathe * 0.013;
      torsoRef.current.rotation.y   = id.torsoY;
      torsoRef.current.rotation.z   = id.torsoZ;
    }

    // ── Head ─────────────────────────────────────────────────────────────────
    if (headRef.current) {
      headRef.current.rotation.x = id.headX;
      headRef.current.rotation.y = id.headY;
      headRef.current.rotation.z = id.headZ;
    }

    // ── Hair — wind-reactive (smooth lag via lerp) ────────────────────────────
    if (hairRef.current) {
      const ws = Math.max(0.25, W.phase);
      hairRef.current.rotation.z += (windX * 0.11 * ws - hairRef.current.rotation.z) * 0.055;
      hairRef.current.rotation.x += (windX * 0.03 * ws - hairRef.current.rotation.x) * 0.040;
    }

    // ── Arms + cloth wind ────────────────────────────────────────────────────
    const sleeveWind = windX * 0.013 * W.phase;
    if (lArmRef.current) {
      lArmRef.current.rotation.z  =  Math.PI / 6 + id.lArmZ;
      lArmRef.current.rotation.x  = sleeveWind;
    }
    if (rArmRef.current) {
      rArmRef.current.rotation.z  = -Math.PI / 6 + id.rArmZ;
      rArmRef.current.rotation.x  = sleeveWind;
    }
    if (lHndRef.current) { lHndRef.current.rotation.z  =  Math.PI / 10 + id.lHndZ; }
    if (rHndRef.current) { rHndRef.current.rotation.z  = -Math.PI / 10 + id.rHndZ; }

    // ── Weight shift ─────────────────────────────────────────────────────────
    if (rootRef.current) { rootRef.current.position.y = id.rootOfsY; }
  });

  // Palette
  const skin  = isWoman ? '#d4956e' : '#bf8555';
  const top   = isWoman ? '#b2aaa0' : '#1c2440';   // coat vs hoodie
  const pants = '#1e2d45';
  const hair  = isWoman ? '#7a5e3a' : '#201c18';
  const shoe  = isWoman ? '#7a6a88' : '#d0c8b8';
  const SW    = isWoman ? 0.46 : 0.50;             // shoulder half-width

  const SEAT = 1.8;  // ledge top-surface y

  return (
    <group ref={rootRef} position={[posX, 0, -79]}>

      {/* ── Legs hanging over the back ledge toward the city ─────────────── */}
      {([-0.14, 0.14] as const).map((lx, si) => (
        <group key={si}>
          {/* Thigh — angled slightly downward in −z */}
          <mesh position={[lx, SEAT - 0.07, -0.52]}
                rotation={[0.28, 0, si === 0 ? 0.04 : -0.04]}>
            <boxGeometry args={[0.22, 0.46, 0.24]} />
            <meshStandardMaterial color={pants} roughness={0.85} />
          </mesh>
          {/* Shin — hangs vertically past ledge edge */}
          <mesh position={[lx, SEAT - 0.70, -0.94]}>
            <boxGeometry args={[0.18, 0.58, 0.18]} />
            <meshStandardMaterial color={pants} roughness={0.85} />
          </mesh>
          {/* Shoe */}
          <mesh position={[lx, SEAT - 1.04, -0.90]}>
            <boxGeometry args={[0.20, 0.15, 0.36]} />
            <meshStandardMaterial color={shoe} roughness={0.72} />
          </mesh>
        </group>
      ))}

      {/* ── Torso group — breathing + posture target applied in useFrame ─── */}
      <group ref={torsoRef} position={[0, 2.58, 0]}>

        {/* Body */}
        <mesh>
          <boxGeometry args={[isWoman ? 0.50 : 0.56, 1.10, 0.32]} />
          <meshStandardMaterial color={top} roughness={0.88} />
        </mesh>

        {/* Left shoulder + upper arm */}
        <group ref={lArmRef} position={[-SW, 0.22, 0]}>
          <mesh>
            <boxGeometry args={[0.19, 0.56, 0.20]} />
            <meshStandardMaterial color={top} roughness={0.88} />
          </mesh>
          {/* Forearm + hand */}
          <group ref={lHndRef} position={[-0.04, -0.46, 0]}>
            <mesh>
              <boxGeometry args={[0.16, 0.44, 0.17]} />
              <meshStandardMaterial color={top} roughness={0.88} />
            </mesh>
            <mesh position={[0, -0.30, 0]}>
              <boxGeometry args={[0.18, 0.22, 0.15]} />
              <meshStandardMaterial color={skin} roughness={0.76} />
            </mesh>
          </group>
        </group>

        {/* Right shoulder + upper arm */}
        <group ref={rArmRef} position={[SW, 0.22, 0]}>
          <mesh>
            <boxGeometry args={[0.19, 0.56, 0.20]} />
            <meshStandardMaterial color={top} roughness={0.88} />
          </mesh>
          <group ref={rHndRef} position={[0.04, -0.46, 0]}>
            <mesh>
              <boxGeometry args={[0.16, 0.44, 0.17]} />
              <meshStandardMaterial color={top} roughness={0.88} />
            </mesh>
            <mesh position={[0, -0.30, 0]}>
              <boxGeometry args={[0.18, 0.22, 0.15]} />
              <meshStandardMaterial color={skin} roughness={0.76} />
            </mesh>
          </group>
        </group>

        {/* Neck */}
        <mesh position={[0, 0.64, 0.02]}>
          <cylinderGeometry args={[0.10, 0.12, 0.22, 8]} />
          <meshStandardMaterial color={skin} roughness={0.76} />
        </mesh>

        {/* Head group — idle rotations applied in useFrame */}
        <group ref={headRef} position={[0, 0.90, 0.02]}>
          <mesh>
            <sphereGeometry args={[isWoman ? 0.27 : 0.29, 12, 10]} />
            <meshStandardMaterial color={skin} roughness={0.80} />
          </mesh>

          {/* Hair — wind-reactive, pivot at scalp */}
          <group ref={hairRef} position={[0, 0.08, 0]}>
            {isWoman ? (
              <>
                {/* Crown */}
                <mesh position={[0, 0.10, -0.04]}>
                  <sphereGeometry args={[0.26, 10, 8]} />
                  <meshStandardMaterial color={hair} roughness={0.92} />
                </mesh>
                {/* Mid-length fall */}
                <mesh position={[0, -0.20, -0.14]}
                      scale={[0.85, 1.35, 0.72]}>
                  <sphereGeometry args={[0.22, 8, 6]} />
                  <meshStandardMaterial color={hair} roughness={0.92} />
                </mesh>
                {/* Ends */}
                <mesh position={[0, -0.48, -0.10]}
                      scale={[0.70, 1.10, 0.62]}>
                  <sphereGeometry args={[0.18, 8, 6]} />
                  <meshStandardMaterial color={hair} roughness={0.92} />
                </mesh>
              </>
            ) : (
              <>
                {/* Short rain-soaked hair */}
                <mesh position={[0, 0.12, -0.02]}>
                  <sphereGeometry args={[0.26, 10, 8]} />
                  <meshStandardMaterial color={hair} roughness={0.94} />
                </mesh>
                <mesh position={[0, 0.08, 0.10]}
                      scale={[0.88, 0.48, 0.78]}>
                  <sphereGeometry args={[0.22, 8, 6]} />
                  <meshStandardMaterial color={hair} roughness={0.94} />
                </mesh>
              </>
            )}
          </group>
        </group>
      </group>
    </group>
  );
}

function Characters() {
  return (
    <group>
      {/* Man — left, dark hoodie */}
      <CharacterFigure posX={-1.8} isWoman={false} breathPhase={0.0} />
      {/* Woman — right, light coat, breath out of phase */}
      <CharacterFigure posX={ 1.2} isWoman={true}  breathPhase={1.4} />
    </group>
  );
}

// ─── Scene root ───────────────────────────────────────────────────────────────
// ─── Cinematic post-processing pass ───────────────────────────────────────────
function CinematicPost() {
  const { gl } = useThree();
  const dofRef   = useRef<any>(null);
  const hsRef    = useRef<any>(null);
  const noiseRef = useRef<any>(null);
  // Static Vector2 for chromatic aberration — avoids per-render allocation
  const caOffset = useMemo(() => new THREE.Vector2(0.00042, 0.00042), []);
  // Character world-space focus point — DOF tracks here regardless of camera phase
  const _charPos = useMemo(() => new THREE.Vector3(0, 1.8, -79), []);

  useEffect(() => {
    // Wire DOF to character position once mounted
    if (dofRef.current) dofRef.current.target = _charPos;
    // Film grain — very subtle; set via blendMode since Noise has no opacity prop.
    // Toned down from 0.038 so grain doesn't chew into crisp highlights.
    if (noiseRef.current?.blendMode) noiseRef.current.blendMode.opacity.value = 0.022;
  }, [_charPos]);

  useFrame(() => {
    // Dynamic exposure — brief lift during lightning flash, smooth lerp back.
    // Base raised slightly from 0.85 so rooftop clutter/wear stays readable;
    // lightning lift trimmed a touch so flashes don't blow out highlights.
    const targetExp = 0.95 + W.lightning * 0.40;
    gl.toneMappingExposure += (targetExp - gl.toneMappingExposure) * 0.10;

    // Color grade — storm peak = cool blue-shift, calm = faint warm hue
    if (hsRef.current) {
      const storm     = W.phase;
      const targetHue = storm * 0.025 - (1.0 - storm) * 0.010;
      const targetSat = storm * 0.06;
      hsRef.current.hue        += (targetHue - hsRef.current.hue)        * 0.04;
      hsRef.current.saturation += (targetSat - hsRef.current.saturation) * 0.04;
    }
  });

  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {/* Bloom — city lights glow, wet puddles pop, lightning halos bloom.
          Threshold raised and intensity/radius trimmed so only the brightest
          sources (beacons, lightning) bloom, keeping highlights crisp. */}
      <Bloom
        luminanceThreshold={0.70}
        luminanceSmoothing={0.45}
        intensity={0.42}
        radius={0.55}
        mipmapBlur
      />
      {/* Depth of field — characters are always sharp; far skyline softly blurred */}
      <DepthOfField
        ref={dofRef}
        worldFocusDistance={120}
        worldFocusRange={60}
        bokehScale={2.0}
        height={480}
      />
      {/* Color grading — hue and saturation driven by storm intensity in useFrame */}
      <HueSaturation ref={hsRef} hue={0} saturation={0} />
      {/* Vignette — subtle frame darkening draws eye toward scene center */}
      <Vignette offset={0.44} darkness={0.46} eskil={false} />
      {/* Chromatic aberration — barely perceptible lateral color fringe */}
      <ChromaticAberration
        offset={caOffset}
        radialModulation={false}
        modulationOffset={0}
      />
      {/* Film grain — very faint ADD blend for movie-like texture */}
      <Noise ref={noiseRef} premultiplied blendFunction={BlendFunction.ADD} />
    </EffectComposer>
  );
}

// ─── Renderer config — ACES filmic tone mapping, PCFSoft shadows ──────────────
function RendererConfig() {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMapping         = THREE.ACESFilmicToneMapping;
    // Raised from 0.85 → 0.95 so rooftop details read clearly without
    // flattening the nighttime mood (CinematicPost re-targets this each frame).
    gl.toneMappingExposure = 0.95;
    gl.shadowMap.enabled   = true;
    gl.shadowMap.type      = THREE.PCFSoftShadowMap;
  }, [gl]);
  return null;
}

// ─── Cinematic lighting — moon, city bounce, rim lights, city fill ────────────
// Extends the scene-level lights; does NOT duplicate ambient or existing points.
function CinematicLighting() {
  const moonRef = useRef<THREE.DirectionalLight>(null);

  useEffect(() => {
    if (!moonRef.current) return;
    const s = moonRef.current.shadow;
    // Tight orthographic frustum covering just the rooftop deck
    s.camera.left   = -75;
    s.camera.right  =  75;
    s.camera.top    =  80;
    s.camera.bottom = -80;
    s.camera.near   =  10;
    s.camera.far    =  260;
    s.mapSize.set(1024, 1024);
    s.radius        =  3.5;   // PCFSoft blur radius
    s.bias          = -0.0006;
    s.camera.updateProjectionMatrix();
  }, []);

  return (
    <>
      {/* Primary moonlight — soft cool-blue key, replaces old Canvas directional */}
      <directionalLight
        ref={moonRef}
        position={[-25, 100, 45]}
        intensity={0.72}
        color="#aac8f0"
        castShadow
      />
      {/* City glow — warm orange directional rising from the skyline below */}
      <directionalLight position={[0, -6, -95]} intensity={0.20} color="#b04c18" />
      {/* Character rim — cool backlight left, separates figures from dark sky */}
      <pointLight position={[-9, 8, -71]} color="#3a77c4" intensity={1.6} distance={30} decay={2} />
      {/* Character rim — cool backlight right */}
      <pointLight position={[ 9, 8, -71]} color="#2d5ea8" intensity={1.2} distance={28} decay={2} />
      {/* City fill — diffuse warm uplight from below the back ledge */}
      <pointLight position={[0, -3, -58]} color="#b04010" intensity={0.9} distance={90} decay={1.4} />
    </>
  );
}

// Falls back to a static night-skyline gradient if the browser/environment
// cannot create a WebGL context (e.g. no GPU available), instead of
// crashing the whole scene with an uncaught renderer error.
class WebGLErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <RooftopSceneFallback />;
    }
    return this.props.children;
  }
}

// Probe WebGL support up front — some sandboxed/headless environments have
// no GPU at all and throw synchronously inside the Three.js renderer, which
// can slip past React error boundaries since it happens off the render path.
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    // Mirror exactly what R3F's <Canvas> does internally — some environments
    // (no GPU device) hand back a context from getContext() that later fails
    // when a real THREE.WebGLRenderer tries to use it, so probe with the
    // actual renderer constructor rather than the raw context call.
    const renderer = new THREE.WebGLRenderer({
      canvas,
      failIfMajorPerformanceCaveat: false,
    });
    renderer.dispose();
    return true;
  } catch {
    return false;
  }
}

function RooftopSceneFallback() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(circle at 50% 30%, #12203f 0%, #050814 60%, #03050a 100%)',
      }}
    />
  );
}

export function RooftopScene() {
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);

  if (!webglAvailable) {
    return (
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 1.5, ease: 'easeInOut' }}
        className="absolute inset-0"
      >
        <RooftopSceneFallback />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 1.5, ease: 'easeInOut' }}
      className="absolute inset-0"
    >
      <WebGLErrorBoundary>
        <Canvas
          gl={{ antialias: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, stencil: false, depth: true }}
          camera={{ fov: 55, near: 0.5, far: 800 }}
          dpr={[1, 1.5]}
        >
          <color attach="background" args={['#03050a']} />
          <fogExp2 attach="fog" args={['#03050a', 0.011]} />

          {/* Scene fill — faint cool ambient keeps shadow areas readable */}
          <ambientLight intensity={0.15} color="#1a2a55" />
          {/* Sky/ground hemisphere — city ember below, deep night blue above */}
          <hemisphereLight args={['#0c1830', '#2a0e04', 0.28]} />
          {/* CinematicLighting: moon directional (castShadow), city bounce, rims, city fill */}
          <CinematicLighting />
          {/* Renderer: ACESFilmic tone mapping + PCFSoft shadow maps */}
          <RendererConfig />

          <CameraRig />
          <Characters />
          <AtmosphericHaze />
          <Rooftop />
          <RooftopDetails />
          <Skyline />
          <DistantBillboards />
          <Streets />
          <Cars />
          <Aircraft />
          <Steam />
          <CinematicRain />
          <SplashParticles />
          <RoofDrips />
          <DynamicWeather />
          <CinematicPost />
        </Canvas>
      </WebGLErrorBoundary>
    </motion.div>
  );
}
