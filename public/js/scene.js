// Three.js scene: renderer, camera, orbit controls, container wireframe,
// and cargo mesh management. Scene units = feet.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getContainer } from './container.js';
import { makeLabelMeshes } from './labels.js';

export class SceneManager {
  constructor(container) {
    this.el = container;
    this.placementMeshes = new Map(); // placementId -> THREE.Group
    this.labelGroups = new Map(); // placementId -> THREE.Group of sticker meshes
    this.labelsVisible = false;

    this.scene = new THREE.Scene();
    this.setThemeBackground();

    const rect = this.el.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(
      50,
      rect.width / Math.max(1, rect.height),
      0.1,
      1000
    );
    this.camera.position.set(30, 24, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(rect.width, rect.height);
    this.el.appendChild(this.renderer.domElement);

    // Orbit with Ctrl/Cmd + left-drag; plain left-drag stays free for cargo.
    // LEFT is assigned ROTATE on the fly (see the pointerdown handler below)
    // only while Ctrl or Cmd is held, so it works across Windows/Linux/Mac.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false; // drags orbit around center; never pan the view
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // Decide orbit-vs-drag on pointerdown, before OrbitControls reads the map.
    // Capture phase guarantees this runs ahead of OrbitControls' own listener.
    this._onPointerDownCapture = (e) => {
      const orbitModifier = e.button === 0 && (e.ctrlKey || e.metaKey);
      this.controls.mouseButtons.LEFT = orbitModifier ? THREE.MOUSE.ROTATE : null;
    };
    this.renderer.domElement.addEventListener(
      'pointerdown', this._onPointerDownCapture, { capture: true }
    );
    // Right-drag no longer orbits; suppress the canvas context menu so a Mac
    // Ctrl+left-drag never pops the browser menu mid-orbit.
    this._onContextMenu = (e) => e.preventDefault();
    this.renderer.domElement.addEventListener('contextmenu', this._onContextMenu);

    // Lights
    const amb = new THREE.AmbientLight(0xffffff, 0.75);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(20, 40, 20);
    this.scene.add(amb, dir);

    this.containerGroup = new THREE.Group();
    this.cargoGroup = new THREE.Group();
    this.scene.add(this.containerGroup, this.cargoGroup);

    this._raf = null;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.animate();
  }

  setThemeBackground() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    this.scene.background = new THREE.Color(light ? 0xeef1f7 : 0x0f1420);
    if (this.grid) {
      this.grid.material.opacity = light ? 0.35 : 0.25;
    }
  }

  animate() {
    this._raf = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height);
  }

  /** Build the container wireframe + floor grid, and frame the camera. */
  setContainer(containerType) {
    this.containerGroup.clear();
    this._containerType = containerType;
    const spec = getContainer(containerType);
    const { length: L, width: W, height: H } = spec;

    // Wireframe box (edges), centered on the container volume.
    const box = new THREE.BoxGeometry(L, H, W);
    const edges = new THREE.EdgesGeometry(box);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x4f8cff })
    );
    line.position.set(L / 2, H / 2, W / 2);
    this.containerGroup.add(line);

    // Translucent floor.
    const floorGeo = new THREE.PlaneGeometry(L, W);
    const floor = new THREE.Mesh(
      floorGeo,
      new THREE.MeshBasicMaterial({
        color: 0x4f8cff,
        transparent: true,
        opacity: 0.06,
        side: THREE.DoubleSide,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(L / 2, 0.001, W / 2);
    this.containerGroup.add(floor);

    this.grid = new THREE.GridHelper(Math.max(L, W), Math.max(L, W), 0x4f8cff, 0x4f8cff);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.2;
    this.grid.position.set(L / 2, 0.002, W / 2);
    this.containerGroup.add(this.grid);

    this.controls.target.set(L / 2, H / 2, W / 2);
    this.camera.position.set(L / 2 + L * 0.7, H + L * 0.5, W / 2 + W * 2.2);
    this.controls.update();
  }

  clearCargo() {
    this.cargoGroup.clear();
    this.placementMeshes.clear();
    this.labelGroups.clear();
  }

  /** Create or update a cargo mesh for a placement. */
  upsertPlacement(p, selected = false) {
    let group = this.placementMeshes.get(p.id);
    const d = p.dims;
    if (!group) {
      group = new THREE.Group();
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(p.color || '#4f8cff'),
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'body';
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x101827 })
      );
      edges.name = 'edges';
      group.add(mesh, edges);
      group.userData.placementId = p.id;
      this.cargoGroup.add(group);
      this.placementMeshes.set(p.id, group);
    }
    const mesh = group.getObjectByName('body');
    const edges = group.getObjectByName('edges');
    mesh.scale.set(d.l, d.h, d.w);
    edges.scale.set(d.l, d.h, d.w);
    mesh.material.color = new THREE.Color(p.color || '#4f8cff');
    mesh.material.emissive = new THREE.Color(selected ? 0x333311 : 0x000000);
    edges.material.color = new THREE.Color(selected ? 0xffc15c : 0x101827);
    // Position by center (placement stores min-corner).
    group.position.set(p.x + d.l / 2, p.y + d.h / 2, p.z + d.w / 2);

    // Update label stickers: rebuild since dims change on rotate/tip.
    const old = this.labelGroups.get(p.id);
    if (old) {
      group.remove(old);
      this.disposeLabelGroup(old);
      this.labelGroups.delete(p.id);
    }
    const labelGroup = new THREE.Group();
    labelGroup.name = 'labels';
    for (const mesh of makeLabelMeshes(p, d)) labelGroup.add(mesh);
    labelGroup.visible = this.labelsVisible;
    group.add(labelGroup);
    this.labelGroups.set(p.id, labelGroup);
    return group;
  }

  removePlacement(id) {
    const group = this.placementMeshes.get(id);
    if (group) {
      this.cargoGroup.remove(group);
      this.placementMeshes.delete(id);
      const lg = this.labelGroups.get(id);
      if (lg) this.disposeLabelGroup(lg);
      this.labelGroups.delete(id);
    }
  }

  /** Dispose geometry/material/texture of a label sticker group. */
  disposeLabelGroup(lg) {
    for (const mesh of lg.children) {
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      }
    }
  }

  /** Sync all meshes to a list of placements (add/update/remove). */
  syncPlacements(placements, selectedId) {
    const seen = new Set();
    for (const p of placements) {
      this.upsertPlacement(p, p.id === selectedId);
      seen.add(p.id);
    }
    for (const id of [...this.placementMeshes.keys()]) {
      if (!seen.has(id)) this.removePlacement(id);
    }
  }

  setLabelsVisible(v) {
    this.labelsVisible = v;
    for (const lg of this.labelGroups.values()) lg.visible = v;
  }

  exportPNG() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ---------------------------------------------------------------------------
  // Multi-view capture for reports (isometric + orthographic elevations/plan).
  // Uses dedicated offscreen cameras so the live interactive camera/controls
  // are never disturbed. Captures are synchronous (preserveDrawingBuffer).
  // ---------------------------------------------------------------------------

  /** Render the scene with a temporary camera and return a PNG data URL. */
  captureWith(camera) {
    this.renderer.render(this.scene, camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    // Restore the live view immediately.
    this.renderer.render(this.scene, this.camera);
    return url;
  }

  /** Canvas aspect (w/h), guarded against zero height. */
  canvasAspect() {
    const rect = this.el.getBoundingClientRect();
    const w = rect.width || this.renderer.domElement.width || 1;
    const h = rect.height || this.renderer.domElement.height || 1;
    return w / Math.max(1, h);
  }

  /**
   * Build an OrthographicCamera framing a `planeW × planeH` region (feet),
   * fit-contained to the canvas aspect (no stretching), looking at `target`
   * from `position` with the given `up` vector.
   */
  makeOrthoCamera(planeW, planeH, position, target, up) {
    const margin = 1.12; // a little breathing room around the container
    const aspect = this.canvasAspect();
    // Fit-contain: grow the smaller dimension so content is never cropped.
    let halfW = (planeW * margin) / 2;
    let halfH = (planeH * margin) / 2;
    if (halfW / halfH < aspect) {
      halfW = halfH * aspect;
    } else {
      halfH = halfW / aspect;
    }
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 5000);
    cam.up.copy(up);
    cam.position.copy(position);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    return cam;
  }

  /** Build the angled isometric perspective camera used for report snapshots. */
  makeIsoCamera(L, W, H) {
    const cam = new THREE.PerspectiveCamera(50, this.canvasAspect(), 0.1, 5000);
    cam.up.set(0, 1, 0);
    cam.position.set(L / 2 + L * 0.7, H + L * 0.5, W / 2 + W * 2.2);
    cam.lookAt(L / 2, H / 2, W / 2);
    cam.updateProjectionMatrix();
    return cam;
  }

  /**
   * Capture one or more report views. Returns a map keyed by view name with
   * PNG data URLs. Views: 'iso', 'side', 'front', 'top'.
   * Options: { labels } temporarily forces label stickers visible.
   */
  captureViews(list = ['iso', 'side', 'front', 'top'], { labels = false } = {}) {
    const spec = getContainer(this._containerType);
    const { length: L, width: W, height: H } = spec;
    const target = new THREE.Vector3(L / 2, H / 2, W / 2);
    // A generous distance so orthographic cameras clear the container fully.
    const dist = Math.max(L, W, H) * 2 + 10;

    // Optionally reveal labels just for the capture pass.
    const prevLabels = this.labelsVisible;
    if (labels !== prevLabels) this.setLabelsVisible(labels);

    const cameras = {
      iso: () => this.makeIsoCamera(L, W, H),
      // Side elevation: view along -Z, shows the L (length) × H (height) plane.
      side: () => this.makeOrthoCamera(
        L, H,
        new THREE.Vector3(L / 2, H / 2, W / 2 + dist),
        target,
        new THREE.Vector3(0, 1, 0)
      ),
      // Front (end) elevation: view along -X, shows the W (width) × H (height) plane.
      front: () => this.makeOrthoCamera(
        W, H,
        new THREE.Vector3(L / 2 + dist, H / 2, W / 2),
        target,
        new THREE.Vector3(0, 1, 0)
      ),
      // Top (plan): view along -Y, shows the L (length) × W (width) plane.
      // up = -Z keeps length running horizontally in the image.
      top: () => this.makeOrthoCamera(
        L, W,
        new THREE.Vector3(L / 2, H / 2 + dist, W / 2),
        target,
        new THREE.Vector3(0, 0, -1)
      ),
    };

    const out = {};
    for (const name of list) {
      const build = cameras[name];
      if (build) out[name] = this.captureWith(build());
    }

    if (labels !== prevLabels) this.setLabelsVisible(prevLabels);
    return out;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.renderer.domElement.removeEventListener(
      'pointerdown', this._onPointerDownCapture, { capture: true }
    );
    this.renderer.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
