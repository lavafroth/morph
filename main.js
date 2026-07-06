import * as THREE from 'three';

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

// actual 3d models
// const sourceGeometry = new THREE.BoxGeometry(1, 1, 1);
const sourceGeometry = new THREE.TorusGeometry( 1, 0.2, 16, 48 );
const sourceMesh = new THREE.Mesh(sourceGeometry, whiteMaterial);

sourceMesh.rotation.y = 0.25;
sourceMesh.rotation.x = 0.3;

const targetGeometry = new THREE.IcosahedronGeometry(1.2, 1);
const targetMesh = new THREE.Mesh(targetGeometry, whiteMaterial);

// capture source
scene3D.add(sourceMesh);
renderer.setRenderTarget(renderTargetSource);
renderer.render(scene3D, camera3D);
scene3D.remove(sourceMesh);

// capture target
scene3D.add(targetMesh);
renderer.setRenderTarget(renderTargetTarget);
renderer.render(scene3D, camera3D);
scene3D.remove(targetMesh);

const vSdfMaterial = new THREE.ShaderMaterial({
  uniforms: {
    sourceTex: { value: null },
    targetTex: { value: null },
    uResolution: { value: new THREE.Vector2(width, height) }
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D sourceTex;
    uniform sampler2D targetTex;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float getSDF(sampler2D tex, vec2 uv) {
      vec2 texel = 1.0 / uResolution;
      bool isInside = texture2D(tex, uv).r > 0.0;
      
      float minD = 200.0; // The pixel radius distance scanning range

      // scan surrounding box to determine spatial proximity to a border
      for (float x = -minD; x <= minD; x += 5.0) {
        for (float y = -minD; y <= minD; y += 5.0) {
          vec2 offset = vec2(x, y);
          vec2 sampleUv = uv + offset * texel;

          if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
            break;
          }
          
          bool sampleInside = texture2D(tex, clamp(sampleUv, 0.0, 1.0)).r > 0.0;
          
          if (isInside != sampleInside) {
            minD = min(minD, length(offset));
          }
        }
      }
      
      return isInside ? -minD : minD;
    }

    void main() {
      float sourceTexel = texture2D(sourceTex, vUv).r;
      float targetTexel = texture2D(targetTex, vUv).r;

      if (sourceTexel == targetTexel) {
        if (targetTexel > 0.5) {
          gl_FragColor = vec4(vec3(-200.0), 1.0);
          return;
        }
        gl_FragColor = vec4(vec3(200.0), 1.0);
        return;
      }
      gl_FragColor = vec4(vec3(getSDF(sourceTex, vUv)), 1.0);
    }
  `
});

// Allocate floating-point targets to store exact mathematical distances cleanly on the GPU
const rtSourceSDF = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
const rtTargetSDF = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });

const bakeScene = new THREE.Scene();
const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vSdfMaterial);
bakeScene.add(bakeQuad);


vSdfMaterial.uniforms.sourceTex.value = renderTargetSource.texture;
vSdfMaterial.uniforms.targetTex.value = renderTargetTarget.texture;
renderer.setRenderTarget(rtSourceSDF);
renderer.render(bakeScene, screenCamera);

vSdfMaterial.uniforms.sourceTex.value = renderTargetTarget.texture;
vSdfMaterial.uniforms.targetTex.value = renderTargetSource.texture;
renderer.setRenderTarget(rtTargetSDF);
renderer.render(bakeScene, screenCamera);

// renderTargetSource.dispose();
// renderTargetTarget.dispose();
renderer.setRenderTarget(null);

const screenShaderMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tSourceSDF: { value: rtSourceSDF.texture },
    tTargetSDF: { value: rtTargetSDF.texture },
    mixAmount: { value: 0.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tSourceSDF;
    uniform sampler2D tTargetSDF;
    uniform float mixAmount;
    varying vec2 vUv;

    void main() {
      float dSource = texture2D(tSourceSDF, vUv).r;
      float dTarget = texture2D(tTargetSDF, vUv).r;

      float morphedDistance = mix(dSource, dTarget, mixAmount);
      float finalMask = morphedDistance <= 0.0 ? 1.0 : 0.0;

      gl_FragColor = vec4(vec3(finalMask), 1.0);
    }
  `
});


const screenShaderMaterialOld = new THREE.ShaderMaterial({
  uniforms: {
    tSource: { value: renderTargetSource.texture },
    tTarget: { value: renderTargetTarget.texture },
    mixAmount: { value: 0.0 },
    uResolution: { value: new THREE.Vector2(width, height) }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tSource;
    uniform sampler2D tTarget;
    uniform float mixAmount;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // Approximates the distance field of the solid mask.
    // Returns a negative distance inside the white mask, and positive distance outside.
    float getSDF(sampler2D tex, vec2 uv) {
      vec2 texel = 1.0 / uResolution;
      bool isInside = texture2D(tex, uv).r > 0.0;
      
      float minD = 200.0; // The pixel radius distance scanning range

      // scan surrounding box to determine spatial proximity to a border
      for (float x = -minD; x <= minD; x += minD / 20.0) {
        for (float y = -minD; y <= minD; y += minD / 20.0) {
          vec2 offset = vec2(x, y);
          vec2 sampleUv = uv + offset * texel;

          if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
            break;
          }
          
          float sampleVal = texture2D(tex, clamp(sampleUv, 0.0, 1.0)).r;
          bool sampleInside = sampleVal > 0.0;
          
          if (isInside != sampleInside) {
            minD = min(minD, length(offset));
          }
        }
      }
      
      return isInside ? -minD : minD;
    }

    void main() {
      float sourceTexel = texture2D(tSource, vUv).r;
      float targetTexel = texture2D(tTarget, vUv).r;

      if (sourceTexel == targetTexel) {
        gl_FragColor = vec4(vec3(targetTexel), 1.0);
        return;
      }
      
      float dSource = getSDF(tSource, vUv);
      float dTarget = getSDF(tTarget, vUv);

      // interpolate spatial layout metrics rather than image textures.
      // forces shapes to structurally expand, erode, and collapse gaps.
      float morphedDistance = mix(dSource, dTarget, mixAmount);

      float finalMask = morphedDistance <= 0.0 ? 1.0 : 0.0;

      gl_FragColor = vec4(vec3(finalMask), 1.0);
    }
  `
});

const quadGeometry = new THREE.PlaneGeometry(2, 2);
const quadMesh = new THREE.Mesh(quadGeometry, screenShaderMaterial);
screenScene.add(quadMesh);

const durationSeconds = 4.0;

function animate() {
  requestAnimationFrame(animate);

  const elapsedTime = clock.getElapsedTime();
  const cycleTime = elapsedTime % durationSeconds;
  const progress = Math.abs((cycleTime / 2.0) - 1.0);
  screenShaderMaterial.uniforms.mixAmount.value = progress;
  renderer.render(screenScene, screenCamera);
}

animate();

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  renderTargetSource.setSize(w, h);
  renderTargetTarget.setSize(w, h);
  // screenShaderMaterial.uniforms.uResolution.value.set(w, h);
});

