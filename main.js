import * as THREE from 'three';

import modelUrl from './mesh.glb?url';
import loadMesh from './loader';
import defaultVertexShader from './default.vert?raw';
import assignMaskMaterial from './mask';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';


const renderer = new THREE.WebGLRenderer({ antialias: true });
const width = window.innerWidth;
const height = window.innerHeight;
renderer.setSize(width, height);
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const screenScene = new THREE.Scene();

const scene3D = new THREE.Scene();
const camera3D = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera3D.position.set(0, 0, 5);

const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(2, 2, 5);
scene3D.add(light, new THREE.AmbientLight(0x404040));



function renderToBuffer(mesh) {
  const buf = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true
  });
  scene3D.add(mesh);
  renderer.setRenderTarget(buf);
  renderer.render(scene3D, camera3D);
  scene3D.remove(mesh);
  return buf;
}

// const sourceGeometry = new THREE.TorusGeometry(1, 0.3, 12, 48);

// const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
// const sourceMesh = new THREE.Mesh(sourceGeometry, new THREE.MeshStandardMaterial({ color: 0xf19ec8 }));
const sourceMesh = await loadMesh(modelUrl);
const targetGeometry = new THREE.IcosahedronGeometry(1.2, 1);
const targetMesh = new THREE.Mesh(targetGeometry, new THREE.MeshStandardMaterial({ color: 0xffa500, flatShading: true }));
sourceMesh.rotation.set(0.3, 0.25, 0);

const sourceTex = renderToBuffer(sourceMesh);
const targetTex = renderToBuffer(targetMesh);

assignMaskMaterial(sourceMesh);
assignMaskMaterial(targetMesh);


const renderTargetSource = renderToBuffer(sourceMesh);
const renderTargetTarget = renderToBuffer(targetMesh);

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

const screenShaderMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tSourceSDF: { value: rtSourceSDF.texture },
    tTargetSDF: { value: rtTargetSDF.texture },
    uResolution: { value: new THREE.Vector2(width, height) },
    tSourceTexture: { value: sourceTex.texture },
    tTargetTexture: { value: targetTex.texture },
    mixAmount: { value: 0.0 }
  },
  vertexShader: defaultVertexShader,
  fragmentShader: `uniform sampler2D tSourceSDF;
uniform sampler2D tTargetSDF; 
uniform sampler2D tSourceTexture;
uniform sampler2D tTargetTexture;
uniform float mixAmount;
uniform vec2 uResolution;
varying vec2 vUv;


void main() {

  float distS = texture(tSourceSDF, vUv).r;
  float distT = texture(tTargetSDF, vUv).r;

  float morphedDistance = mix(distS, distT, mixAmount);
  float delta = fwidth(morphedDistance);
  float epsilon = 0.001; 
  float finalAlpha = smoothstep(epsilon + delta, epsilon - delta, morphedDistance);

  vec2 texelSize = 1.5 / uResolution;
  
  float dSl = texture(tSourceSDF, vUv - vec2(texelSize.x, 0.0)).r;
  float dSr = texture(tSourceSDF, vUv + vec2(texelSize.x, 0.0)).r;
  float dSd = texture(tSourceSDF, vUv - vec2(0.0, texelSize.y)).r;
  float dSu = texture(tSourceSDF, vUv + vec2(0.0, texelSize.y)).r;
  vec2 gradS = vec2(dSr - dSl, dSu - dSd);

  float dTl = texture(tTargetSDF, vUv - vec2(texelSize.x, 0.0)).r;
  float dTr = texture(tTargetSDF, vUv + vec2(texelSize.x, 0.0)).r;
  float dTd = texture(tTargetSDF, vUv - vec2(0.0, texelSize.y)).r;
  float dTu = texture(tTargetSDF, vUv + vec2(0.0, texelSize.y)).r;
  vec2 gradT = vec2(dTr - dTl, dTu - dTd);

  gradS = length(gradS) > 0.001 ? normalize(gradS) : vec2(0.0);
  gradT = length(gradT) > 0.001 ? normalize(gradT) : vec2(0.0);

  vec2 unifiedVector = mix(gradS, gradT, mixAmount);
  
  float warpIntensity = 0.15;
  float warpStrength = abs(morphedDistance) * warpIntensity;
  
  vec2 uvSource = vUv + (unifiedVector * warpStrength * mixAmount) / uResolution.x;
  vec2 uvTarget = vUv - (unifiedVector * warpStrength * (1.0 - mixAmount)) / uResolution.x;

  float lodSource = clamp(abs(distT * mixAmount) * 0.5, 0.0, 5.0);
  float lodTarget = clamp(abs(distS * (1.0 - mixAmount)) * 0.5, 0.0, 5.0);

  vec4 colorSource = textureLod(tSourceTexture, uvSource, lodSource);
  vec4 colorTarget = textureLod(tTargetTexture, uvTarget, lodTarget);
  vec4 finalColor = mix(colorSource, colorTarget, mixAmount);

  gl_FragColor = vec4(finalColor.rgb * finalAlpha, 1.0);
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

