import * as THREE from 'three';
import { hash01 } from './layout';
import { activePalette, themeHue } from './theme';

export function projectColor(project: string, index: number): THREE.Color {
  const palette = activePalette();
  const hex = palette[index % palette.length];
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const hue = themeHue();
  if (hsl.s < 0.05) {
    // grayscale palette (Mono): hue slider colourizes instead of rotating.
    // 0 = untouched grayscale; anything above tints the whole vault.
    if (hue > 0) c.setHSL(hue / 360 + (hash01(project, 5) - 0.5) * 0.03, 0.6, hsl.l);
  } else {
    // user hue rotation + slight per-project variance so repeats differ
    c.offsetHSL(hue / 360 + (hash01(project, 5) - 0.5) * 0.04, 0, 0);
  }
  return c;
}

export const MATRIX_GREEN = new THREE.Color('#00ff66');

/**
 * Glass-orb node material: emissive plasma core fading into a translucent
 * tinted rim (fresnel). Reads instanceColor, so per-node brightness/dimming
 * from the frame loop keeps working. Additive → order-independent, no sorting.
 */
export function makeGlassNodeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vColor;
      void main() {
        mat4 mv = modelViewMatrix;
        #ifdef USE_INSTANCING
          mv = mv * instanceMatrix;
        #endif
        vColor = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #endif
        vec4 mvPosition = mv * vec4(position, 1.0);
        vNormal = normalize(mat3(mv) * normal);
        vView = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vColor;
      void main() {
        float facing = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
        float rim = pow(1.0 - facing, 2.2);   // glass shell edge
        float core = pow(facing, 2.2);        // plasma core, hottest at centre
        vec3 col = vColor * core * 1.55                 // interior glow
                 + vColor * rim * 0.85                  // tinted rim
                 + vec3(1.0) * pow(facing, 7.0) * 0.3;  // white-hot pinpoint
        float alpha = clamp(rim * 0.75 + core, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// ─────────────────────────────────────────────────────────────

/** Distant starfield sphere for universe mode. */
export function makeStarfield(): THREE.Points {
  const N = 2600;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.acos(2 * Math.random() - 1);
    const r = 700 + Math.random() * 500;
    pos[i * 3] = r * Math.sin(v) * Math.cos(u);
    pos[i * 3 + 1] = r * Math.cos(v);
    pos[i * 3 + 2] = r * Math.sin(v) * Math.sin(u);
    c.setHSL(0.55 + Math.random() * 0.15, 0.4, 0.55 + Math.random() * 0.35);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: false,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -10;
  return pts;
}

/** Ghostly cortex shell: two wrinkled hemisphere point clouds. */
export function makeBrainShell(): THREE.Points {
  const PER_SIDE = 4200;
  const pos = new Float32Array(PER_SIDE * 2 * 3);
  const col = new Float32Array(PER_SIDE * 2 * 3);
  const R = 120, GAP = 18;
  const left = new THREE.Color('#ff6ec7');
  const right = new THREE.Color('#7df9ff');
  let w = 0;
  for (let side = -1; side <= 1; side += 2) {
    const tint = side < 0 ? left : right;
    for (let i = 0; i < PER_SIDE; i++) {
      // sample hemisphere surface, biased upward like a cortex
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(1 - Math.random() * 1.55); // fuller than half-dome, open at bottom
      const dir = new THREE.Vector3(
        Math.abs(Math.sin(v) * Math.cos(u)) * side,
        Math.cos(v),
        Math.sin(v) * Math.sin(u)
      ).normalize();
      const wr = 1 + 0.055 * Math.sin(dir.y * 14 + dir.z * 11) * Math.cos(dir.z * 9 + dir.x * 6);
      pos[w * 3] = dir.x * R * 0.82 * wr + side * GAP;
      pos[w * 3 + 1] = dir.y * R * 0.72 * wr;
      pos[w * 3 + 2] = dir.z * R * wr;
      const b = 0.35 + Math.random() * 0.4;
      col[w * 3] = tint.r * b; col[w * 3 + 1] = tint.g * b; col[w * 3 + 2] = tint.b * b;
      w++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.1,
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -5;
  return pts;
}

/** Retint the cortex shell to the theme's hemisphere colours (left, right). */
export function tintBrainShell(shell: THREE.Points, left: THREE.Color, right: THREE.Color): void {
  const col = shell.geometry.getAttribute('color') as THREE.BufferAttribute;
  const half = col.count / 2;
  for (let i = 0; i < col.count; i++) {
    const tint = i < half ? left : right;
    const b = 0.35 + hash01(String(i), 7) * 0.4;
    col.setXYZ(i, tint.r * b, tint.g * b, tint.b * b);
  }
  col.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────
// Matrix digital rain — glyph atlas on a camera-locked backdrop plane
// ─────────────────────────────────────────────────────────────

function makeGlyphAtlas(): THREE.CanvasTexture {
  const GRID = 8, CELL = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = GRID * CELL;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${CELL * 0.72}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ΦΨΣΞ<>#*+=';
  for (let i = 0; i < GRID * GRID; i++) {
    const ch = glyphs[i % glyphs.length];
    const x = (i % GRID) * CELL + CELL / 2;
    const y = Math.floor(i / GRID) * CELL + CELL / 2;
    ctx.fillText(ch, x, y);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function makeMatrixRain(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uAtlas: { value: makeGlyphAtlas() },
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;
      uniform sampler2D uAtlas;
      varying vec2 vUv;

      float rnd(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      void main() {
        vec2 grid = vec2(90.0, 50.0);
        vec2 cell = floor(vUv * grid);
        vec2 cuv = fract(vUv * grid);

        float colSeed = rnd(vec2(cell.x, 0.0));
        float speed = 6.0 + colSeed * 14.0;
        float head = fract(colSeed * 7.0 - uTime * speed / grid.y);
        float rowPos = cell.y / grid.y;
        float trail = fract(head - rowPos);
        float bright = pow(1.0 - trail, 5.5);

        // glyph cycling
        float gIdx = floor(rnd(cell + floor(uTime * (2.0 + colSeed * 6.0))) * 64.0);
        vec2 gCell = vec2(mod(gIdx, 8.0), floor(gIdx / 8.0));
        vec2 auv = (gCell + cuv) / 8.0;
        float glyph = texture2D(uAtlas, auv).r;

        float headGlow = smoothstep(0.03, 0.0, trail);
        vec3 color = mix(vec3(0.0, 1.0, 0.4) * bright, vec3(0.75, 1.0, 0.85), headGlow);
        float alpha = glyph * max(bright, headGlow) * uOpacity;
        gl_FragColor = vec4(color, alpha * 0.85);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2400, 1300), mat);
  mesh.renderOrder = -20;
  mesh.visible = false;
  return mesh;
}
