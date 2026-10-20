import { Box3, Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Loads the baked fly (fly-frame millimetres: +x anterior, +y fly's left, +z dorsal)
// under `flyRoot`, then rotates flyRoot once so fly +z (dorsal) is three.js +y (up).
// Everything authored in fly coordinates (axes, planes) should be a child of flyRoot.
export async function loadFly(url) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);

  const flyRoot = new Group();
  flyRoot.name = 'flyRoot';
  flyRoot.rotation.x = -Math.PI / 2;
  flyRoot.add(gltf.scene);

  gltf.scene.traverse((obj) => {
    if (obj.isMesh && obj.material.transparent) {
      // Wings: draw after the opaque body and don't occlude what's behind them.
      obj.material.depthWrite = false;
      obj.renderOrder = 1;
    }
  });

  flyRoot.updateMatrixWorld(true);
  const box = new Box3().setFromObject(flyRoot);
  return { flyRoot, box };
}
