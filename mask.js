import { MeshBasicMaterial } from 'three';

const whiteMaterial = new MeshBasicMaterial({ color: 0xffffff });

export default function assignMaskMaterial(mesh) {
  mesh.traverse((child) => {
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
}
