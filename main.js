import * as THREE from 'three';

import modelUrl from './mesh.glb?url';
import loadMesh from './loader';
import defaultVertexShader from './default.vert?raw';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';


const renderer = new THREE.WebGLRenderer({ antialias: true });
const width = window.innerWidth;
const height = window.innerHeight;
renderer.setSize(width, height);
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const screenScene = new THREE.Scene();

const renderTargetSource = new THREE.WebGLRenderTarget(width, height);
const renderTargetTarget = new THREE.WebGLRenderTarget(width, height);

const scene3D = new THREE.Scene();
const camera3D = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera3D.position.set(0, 0, 5);

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(2, 2, 5);
scene3D.add(light, new THREE.AmbientLight(0x404040));

const whiteMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

// const sourceGeometry = new THREE.TorusGeometry(1, 0.2, 16, 48);

// const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
// const sourceMesh = new THREE.Mesh(sourceGeometry, whiteMaterial);

const sourceMesh = await loadMesh(modelUrl);

sourceMesh.traverse((child) => {
  if (!child.isMesh) return;

  if (child.material) {
    if (Array.isArray(child.material)) {
      child.material.forEach(mat => mat.dispose());
      return;
    }
    child.material.dispose();
  }

  // Assign the plain white material
  child.material = whiteMaterial;
});

sourceMesh.rotation.set(0.3, 0.25, 0);

const targetGeometry = new THREE.IcosahedronGeometry(1.2, 1);
const targetMesh = new THREE.Mesh(targetGeometry, whiteMaterial);

function renderToBuffer(mesh, target) {
  scene3D.add(mesh);
  renderer.setRenderTarget(target);
  renderer.render(scene3D, camera3D);
  scene3D.remove(mesh);
}

renderToBuffer(sourceMesh, renderTargetSource);
renderToBuffer(targetMesh, renderTargetTarget);

// createOutlineArrayTexture extracts outlines and saves them to a 512x512 texture array
function createOutlineArrayTexture(renderTarget) {
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);

  const outlinePoints = [];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;

      if (!pixels[idx]) continue;
      
      const left  = pixels[(y * width + (x - 1)) * 4];
      const right = pixels[(y * width + (x + 1)) * 4];
      const up    = pixels[((y + 1) * width + x) * 4];
      const down  = pixels[((y - 1) * width + x) * 4];

      if (left && right && up && down) continue;

      // atleast one neighbor is 0 => current pixel is outline
      outlinePoints.push({ x: x / width, y: y / height });
    }
  }

  const dataTextureBuffer = new Float32Array(512 * 512 * 4);

  // rgba = xy_? where `?` indicates existence
  for (let i = 0; i < outlinePoints.length && i < 512 * 512; i++) {
    dataTextureBuffer[i * 4 + 0] = outlinePoints[i].x;
    dataTextureBuffer[i * 4 + 1] = outlinePoints[i].y;
    dataTextureBuffer[i * 4 + 3] = 1.0;
  }

  const texture = new THREE.DataTexture(dataTextureBuffer, 512, 512, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

const tSourceOutlineArray = createOutlineArrayTexture(renderTargetSource);
const tTargetOutlineArray = createOutlineArrayTexture(renderTargetTarget);

const sdfBakeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tOutlineArray: { value: null },
    tShapeMask: { value: null },
    uResolution: { value: new THREE.Vector2(width, height) }
  },
  vertexShader: defaultVertexShader,
  fragmentShader: `
    uniform sampler2D tOutlineArray;
    uniform sampler2D tShapeMask;
    uniform vec2 uResolution;
    varying vec2 vUv;

    vec4 getArrayEntry(int linearIndex) {
      float i = float(linearIndex);
      float x = mod(i, 512.0);
      float y = floor(i / 512.0);
      vec2 lookupUv = (vec2(x, y) + 0.5) / 512.0;
      return texture2D(tOutlineArray, lookupUv);
    }

    void main() {
      float aspect = uResolution.x / uResolution.y;
      float calculatedDist = 9999.0;

      for (int i = 0; i < 4096; i++) {
        vec4 entry = getArrayEntry(i);

        if (entry.a == 0.0) break; // refer to definition rgba = xy_?

        vec2 diff = entry.xy - vUv;
        diff.y /= aspect;
        calculatedDist = min(calculatedDist, length(diff * uResolution.x));
      }

      if (texture2D(tShapeMask, vUv).r > 0.5) {
        calculatedDist = -calculatedDist;
      }

      gl_FragColor = vec4(vec3(calculatedDist), 1.0);
    }
  `
});

const createSdfTarget = () => new THREE.WebGLRenderTarget(width, height, {
  type: THREE.FloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter
});

const rtSourceSDF = createSdfTarget();
const rtTargetSDF = createSdfTarget();

const bakeQuad = new FullScreenQuad(sdfBakeMaterial);

function bakeSDF(arrayTexture, rawMaskRT, finalSdfRT) {
  renderer.setRenderTarget(null);
  
  sdfBakeMaterial.uniforms.tOutlineArray.value = arrayTexture;
  sdfBakeMaterial.uniforms.tShapeMask.value = rawMaskRT.texture;
  renderer.setRenderTarget(finalSdfRT);
  bakeQuad.render(renderer);

  renderer.setRenderTarget(null);
}

bakeSDF(tSourceOutlineArray, renderTargetSource, rtSourceSDF);
bakeSDF(tTargetOutlineArray, renderTargetTarget, rtTargetSDF);

tSourceOutlineArray.dispose();
tTargetOutlineArray.dispose();
renderTargetSource.dispose();
renderTargetTarget.dispose();

const screenShaderMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tSourceSDF: { value: rtSourceSDF.texture },
    tTargetSDF: { value: rtTargetSDF.texture },
    mixAmount: { value: 0.0 }
  },
  vertexShader: defaultVertexShader,
  fragmentShader: `
    uniform sampler2D tSourceSDF;
    uniform sampler2D tTargetSDF; 
    uniform float mixAmount;
    varying vec2 vUv;

    void main() {
      float distS = texture2D(tSourceSDF, vUv).r;
      float distT = texture2D(tTargetSDF, vUv).r;

      float morphedDistance = mix(distS, distT, mixAmount);

      
      // float finalAlpha = morphedDistance < 0.001 ? 1.0 : 0.;
      // the code below is equivalent to the above + anti aliasing
      
      float delta = fwidth(morphedDistance);
      float epsilon = 0.001; 
      float finalAlpha = smoothstep(epsilon + delta, epsilon - delta, morphedDistance);
      gl_FragColor = vec4(vec3(finalAlpha), 1.0);
    }
  `
});

const toScreenQuad = new FullScreenQuad(screenShaderMaterial);
const durationSeconds = 4.0;

function animate() {
  requestAnimationFrame(animate);

  const elapsedTime = clock.getElapsedTime();
  const cycleTime = elapsedTime % durationSeconds;
  const progress = Math.abs((cycleTime / 2.0) - 1.0);

  screenShaderMaterial.uniforms.mixAmount.value = progress * progress;
  toScreenQuad.render(renderer);
}

animate();

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  screenShaderMaterial.uniforms.uResolution.value.set(w, h);
});

