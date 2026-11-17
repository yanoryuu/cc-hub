// 3D モデルの表示(three.js)。重いので ModelViewer から動的 import で読み込む
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export type ModelFormat = 'fbx' | 'stl' | 'glb' | 'gltf';

export interface ModelStats {
  triangles: number;
  meshes: number;
  /** バウンディングボックスの大きさ(モデルの単位のまま) */
  size: [number, number, number];
  clips: string[];
}

export interface ModelHandle {
  resetView(): void;
  setWireframe(on: boolean): void;
  setGrid(on: boolean): void;
  setAutoRotate(on: boolean): void;
  /** アニメーション(-1 で止める) */
  playClip(index: number): void;
  dispose(): void;
}

export interface MountOptions {
  onProgress?: (ratio: number | null) => void;
  /** 見つからなかったテクスチャの数(外して素の色で表示する) */
  onMissingTextures?: (n: number) => void;
}

const MAP_KEYS = ['map', 'normalMap', 'bumpMap', 'specularMap', 'emissiveMap', 'alphaMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'lightMap'] as const;

/** 読み込めなかったテクスチャ(画像が空)を外す。外さないと真っ黒に表示される */
function dropMissingTextures(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const rec = mat as unknown as Record<string, THREE.Texture | null | undefined>;
      for (const k of MAP_KEYS) {
        const t = rec[k];
        const img = t?.image as { width?: number } | undefined;
        if (t instanceof THREE.Texture && !(img && (img.width ?? 0) > 0)) {
          rec[k] = null;
          t.dispose();
          mat.needsUpdate = true;
          n++;
        }
      }
    }
  });
  return n;
}

function load(url: string, fmt: ModelFormat, manager: THREE.LoadingManager, onProgress: (e: ProgressEvent) => void): Promise<{ root: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  return new Promise((resolve, reject) => {
    if (fmt === 'stl') {
      new STLLoader(manager).load(
        url,
        (geo) => {
          if (!geo.getAttribute('normal')) geo.computeVertexNormals();
          const hasColor = !!geo.getAttribute('color');
          const mat = new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xb8bcc4, vertexColors: hasColor, metalness: 0.1, roughness: 0.65 });
          const mesh = new THREE.Mesh(geo, mat);
          // STL は Z 上が多い(3D プリンタ・CAD)ので Y 上に起こす
          mesh.rotation.x = -Math.PI / 2;
          const g = new THREE.Group();
          g.add(mesh);
          resolve({ root: g, clips: [] });
        },
        onProgress,
        reject,
      );
    } else if (fmt === 'fbx') {
      new FBXLoader(manager).load(url, (obj) => resolve({ root: obj, clips: obj.animations ?? [] }), onProgress, reject);
    } else {
      const l = new GLTFLoader(manager);
      l.setMeshoptDecoder(MeshoptDecoder);
      l.load(url, (gltf) => resolve({ root: gltf.scene, clips: gltf.animations ?? [] }), onProgress, reject);
    }
  });
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

/** container に 3D ビューを作ってモデルを読み込む。失敗したら reject(作ったものは片付ける) */
export async function mountModel(container: HTMLElement, url: string, fmt: ModelFormat, opts: MountOptions = {}): Promise<{ handle: ModelHandle; stats: ModelStats }> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'm3d-canvas';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444450, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 1.5;

  let disposed = false;
  let root: THREE.Object3D | null = null;
  let grid: THREE.GridHelper | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let clips: THREE.AnimationClip[] = [];
  let last = performance.now();
  const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  let fitHome = () => {};

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  renderer.setAnimationLoop(() => {
    const t = performance.now();
    if (mixer) mixer.update(Math.min((t - last) / 1000, 0.1));
    last = t;
    controls.update();
    renderer.render(scene, camera);
  });

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.dispose();
    mixer?.stopAllAction();
    if (root) disposeObject(root);
    grid?.geometry.dispose();
    (grid?.material as THREE.Material | undefined)?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };

  try {
    const manager = new THREE.LoadingManager();
    let failed = 0;
    let missing = 0;
    const fixMissing = () => {
      if (disposed || !root || failed === 0) return;
      missing += dropMissingTextures(root);
      opts.onMissingTextures?.(missing);
    };
    manager.onError = () => {
      failed++;
    };
    manager.onLoad = () => fixMissing();
    const loaded = await load(url, fmt, manager, (e) => opts.onProgress?.(e.lengthComputable && e.total ? e.loaded / e.total : null));
    if (disposed) throw new Error('disposed');
    root = loaded.root;
    clips = loaded.clips;
    scene.add(root);

    // 中心を原点・足元を y=0 に置き、カメラを大きさに合わせる
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error('表示できる形状がありません');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    const radius = Math.max(size.length() / 2, 1e-4);
    // 縦長の画面(スマホ)でも左右が切れないよう、縦横の狭い方の画角で距離を決める
    fitHome = () => {
      const vHalf = (camera.fov * Math.PI) / 360;
      const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
      const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
      camera.near = dist / 1000;
      camera.far = dist * 100;
      camera.updateProjectionMatrix();
      home.target.set(0, size.y / 2, 0);
      home.pos.set(0.6, 0.45, 0.75).normalize().multiplyScalar(dist).add(home.target);
    };
    fitHome();
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
    controls.update();

    const span = Math.max(size.x, size.z) * 2 || 1;
    grid = new THREE.GridHelper(span, 20, 0x666670, 0x3a3a40);
    scene.add(grid);

    let triangles = 0;
    let meshes = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      meshes++;
      const idx = m.geometry.getIndex();
      const pos = m.geometry.getAttribute('position');
      triangles += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    });

    // テクスチャは本体より後に読み込まれるので、少し待ってからも確かめる
    fixMissing();
    setTimeout(fixMissing, 1500);

    if (clips.length) {
      mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(clips[0]).play();
    }

    const handle: ModelHandle = {
      resetView() {
        fitHome();
        camera.position.copy(home.pos);
        controls.target.copy(home.target);
        controls.update();
      },
      setWireframe(on) {
        root?.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = on;
          }
        });
      },
      setGrid(on) {
        if (grid) grid.visible = on;
      },
      setAutoRotate(on) {
        controls.autoRotate = on;
      },
      playClip(i) {
        if (!mixer) return;
        mixer.stopAllAction();
        if (i >= 0 && clips[i]) mixer.clipAction(clips[i]).reset().play();
      },
      dispose: cleanup,
    };
    return {
      handle,
      stats: { triangles: Math.round(triangles), meshes, size: [size.x, size.y, size.z], clips: clips.map((c, i) => c.name || `クリップ ${i + 1}`) },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
