import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export default function loadMesh(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(url, (gltf) => resolve(gltf.scene.children[0]), undefined, reject);
  });
}
