// Three.js scene: renderer, camera, orbit controls, container wireframe,
// and cargo mesh management. Scene units = feet.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getContainer, getOpenings, openingBounds, fmtFeet } from './container.js';
import { makeLabelMeshes, makeTagSprite } from './labels.js';

export class SceneManager {
  constructor(container) {
    this.el = container;
    this.placementMeshes = new Map(); // placementId -> THREE.Group
    this.labelGroups = new Map(); // placementId -> THREE.Group of sticker meshes
    this.labelsVisible = true;

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

    // Orbit with Ctrl/Cmd + left-drag; pan (move the pivot/target) with
    // Shift+Ctrl/Cmd + left-drag; plain left-drag stays free for cargo.
    // LEFT is assigned on the fly (see the pointerdown handler below) only
    // while Ctrl or Cmd is held, so it works across Windows/Linux/Mac.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true; // needed for Shift+Ctrl/Cmd pivot pan below
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // Decide orbit-vs-pan-vs-drag on pointerdown, before OrbitControls reads
    // the map. Capture phase guarantees this runs ahead of OrbitControls' own
    // listener.
    //
    // OrbitControls swaps ROTATE<->PAN internally whenever ctrl/meta/shift is
    // held on mousedown. Since our modifiers below always hold ctrl/meta, that
    // swap always fires exactly once, so we get the *opposite* of whatever we
    // assign here:
    //   Ctrl/Cmd only        -> assign PAN    -> library flips to ROTATE (orbit)
    //   Ctrl/Cmd + Shift     -> assign ROTATE -> library flips to PAN (move pivot)
    this._onPointerDownCapture = (e) => {
      const hasCtrlOrMeta = e.button === 0 && (e.ctrlKey || e.metaKey);
      const panModifier = hasCtrlOrMeta && e.shiftKey; // Shift+Ctrl/Cmd: move pivot
      const orbitModifier = hasCtrlOrMeta && !e.shiftKey; // Ctrl/Cmd only: orbit
      this.controls.mouseButtons.LEFT = panModifier
        ? THREE.MOUSE.ROTATE
        : orbitModifier
          ? THREE.MOUSE.PAN
          : null;
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
    // Staging layout for remaining (unplaced) catalog items, shown beside the
    // container when the "Pending Items" view is toggled on.
    this.pendingGroup = new THREE.Group();
    this.pendingGroup.visible = false;
    // Invisible catcher planes at the 6 container boundaries (front/back
    // walls, left/right walls, floor, roof) so the Measure tool can snap a
    // click onto "the wall"/"the roof" even where no cargo mesh is present.
    // Kept invisible (raycasting doesn't require visibility) and repositioned
    // whenever the container geometry changes in setContainer().
    this.boundaryGroup = new THREE.Group();
    this.boundaryGroup.visible = false;
    // Door/jamb opening overlay: the jamb mask (what's BLOCKED), the clear
    // opening outline + dimension label, and the entry envelope (the volume
    // reachable through the opening). Visible by default — it's a constraint,
    // not decoration. Rebuilt by buildOpenings() on every setContainer().
    this.openingGroup = new THREE.Group();
    this.openingsVisible = true;
    // Measurement markers/lines drawn by the Measure tool (see measure.js).
    this.measureGroup = new THREE.Group();
    this.scene.add(
      this.containerGroup, this.cargoGroup, this.pendingGroup,
      this.openingGroup, this.boundaryGroup, this.measureGroup
    );

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
    // Only re-frame the camera on the first build or when the container type
    // actually changes. Plain refreshes (place/delete/edit/nudge/etc.) rebuild
    // the geometry but must preserve the user's current viewpoint.
    const changed = this._containerType !== containerType;
    if (!changed) return;
    this.disposeGroupContents(this.containerGroup);
    this.containerGroup.clear();
    this._containerType = containerType;
    const spec = getContainer(containerType);
    const { length: L, width: W, height: H } = spec;

    // Wireframe box (edges), centered on the container volume.
    const box = new THREE.BoxGeometry(L, H, W);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
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

    if (changed) {
      this.controls.target.set(L / 2, H / 2, W / 2);
      this.camera.position.set(L / 2 + L * 0.7, H + L * 0.5, W / 2 + W * 2.2);
      this.controls.update();
    }

    this.rebuildBoundaryPlanes(L, W, H);
    this.buildOpenings(spec);
  }

  /**
   * Visualize each door/jamb opening in three layers, so a planner can see at
   * a glance that the hole is smaller than the box:
   *
   *  1. JAMB MASK — translucent amber strips over the part of the face that is
   *     BLOCKED: the header band across the top plus the two side-jamb
   *     slivers. Drawing the obstruction (rather than just outlining the hole)
   *     is what makes the lost headroom read as a physical lintel.
   *  2. CLEAR OPENING — a bright outline of the usable hole, with a floating
   *     dimension label ("End doors — 7' 8" W x 7' 5" H clear").
   *  3. ENTRY ENVELOPE — a very faint volume swept from the opening straight
   *     through the container. Cargo sitting outside this volume could never
   *     have been carried in through the door.
   */
  buildOpenings(spec) {
    this.disposeGroupContents(this.openingGroup);
    this.openingGroup.clear();
    this.openingGroup.visible = this.openingsVisible;

    const { length: L, width: W, height: H } = spec;
    const OFF = 0.02; // nudge off the face to avoid z-fighting with the wireframe

    for (const opening of getOpenings(spec)) {
      const b = openingBounds(spec, opening);
      const endFace = b.axis === 'x';
      // Face-local horizontal axis: z for an end opening, x for a side one.
      const faceSpan = endFace ? W : L;
      // Push the overlay slightly INTO the container from its face.
      const facePos = b.plane + OFF * b.inward;

      // Place a rect given face-local bounds [s0,s1] x [y0,y1].
      const addRect = (s0, s1, y0, y1, material) => {
        const w = Math.abs(s1 - s0);
        const h = Math.abs(y1 - y0);
        if (w <= 1e-6 || h <= 1e-6) return null;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
        const sMid = (s0 + s1) / 2;
        const yMid = (y0 + y1) / 2;
        if (endFace) {
          mesh.position.set(facePos, yMid, sMid);
          mesh.rotation.y = Math.PI / 2;
        } else {
          mesh.position.set(sMid, yMid, facePos);
        }
        this.openingGroup.add(mesh);
        return mesh;
      };

      // --- 1. Jamb mask: the blocked area around the clear opening. ---
      const maskMat = new THREE.MeshBasicMaterial({
        color: 0xffc15c,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      // Header band (above the opening) — the headroom you actually lose.
      addRect(0, faceSpan, b.yHi, H, maskMat);
      // Sill band (below the opening), when the opening doesn't start at the floor.
      addRect(0, faceSpan, 0, b.yLo, maskMat);
      // Side jambs (left/right of the opening).
      addRect(0, b.spanLo, b.yLo, b.yHi, maskMat);
      addRect(b.spanHi, faceSpan, b.yLo, b.yHi, maskMat);

      // --- 2. Clear opening outline + dimension label. ---
      const outlineGeo = new THREE.BufferGeometry();
      const corners = endFace
        ? [
            [facePos, b.yLo, b.spanLo], [facePos, b.yLo, b.spanHi],
            [facePos, b.yHi, b.spanHi], [facePos, b.yHi, b.spanLo],
          ]
        : [
            [b.spanLo, b.yLo, facePos], [b.spanHi, b.yLo, facePos],
            [b.spanHi, b.yHi, facePos], [b.spanLo, b.yHi, facePos],
          ];
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push(...corners[i], ...corners[(i + 1) % 4]);
      }
      outlineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.openingGroup.add(new THREE.LineSegments(
        outlineGeo,
        new THREE.LineBasicMaterial({ color: 0xffa726 })
      ));

      const label = makeTagSprite(
        `${opening.label} — ${fmtFeet(b.width)} W × ${fmtFeet(b.height)} H clear`,
        '#ffa726'
      );
      // Float the label just outside the opening, centered on it.
      const labelOut = b.plane - 1.2 * b.inward;
      const sMid = (b.spanLo + b.spanHi) / 2;
      if (endFace) label.position.set(labelOut, b.yHi + 0.9, sMid);
      else label.position.set(sMid, b.yHi + 0.9, labelOut);
      this.openingGroup.add(label);

      // --- 3. Entry envelope: the opening swept through the container. ---
      const depth = endFace ? L : W;
      const envGeo = new THREE.BoxGeometry(
        endFace ? depth : b.width,
        b.height,
        endFace ? b.width : depth
      );
      const env = new THREE.Mesh(envGeo, new THREE.MeshBasicMaterial({
        color: 0xffa726,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      const envMid = b.plane + (depth / 2) * b.inward;
      const yMid = (b.yLo + b.yHi) / 2;
      if (endFace) env.position.set(envMid, yMid, sMid);
      else env.position.set(sMid, yMid, envMid);
      env.name = 'entry-envelope';
      this.openingGroup.add(env);
    }
  }

  /** Show/hide the door-jamb overlay (jamb mask, outline, entry envelope). */
  setOpeningsVisible(v) {
    this.openingsVisible = v;
    this.openingGroup.visible = v;
  }

  /**
   * Build 6 invisible catcher planes at the container's boundaries — front
   * wall (x=0), back wall (x=L), left wall (z=0), right wall (z=W), floor
   * (y=0), roof (y=H) — each tagged userData.boundary with a name, so the
   * Measure tool can raycast onto "the wall"/"the roof" even where no cargo
   * mesh sits. Rendering stays off (boundaryGroup.visible=false); raycasting
   * still works on hidden objects.
   */
  rebuildBoundaryPlanes(L, W, H) {
    this.disposeGroupContents(this.boundaryGroup);
    this.boundaryGroup.clear();
    const mat = () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const addPlane = (name, w, h, position, rotation) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const mesh = new THREE.Mesh(geo, mat());
      mesh.position.copy(position);
      if (rotation) mesh.rotation.copy(rotation);
      mesh.userData.boundary = name;
      this.boundaryGroup.add(mesh);
    };
    const rx = (v) => new THREE.Euler(v, 0, 0);
    const ry = (v) => new THREE.Euler(0, v, 0);
    // Floor / roof: horizontal planes, spanning L × W.
    addPlane('floor', L, W, new THREE.Vector3(L / 2, 0, W / 2), rx(-Math.PI / 2));
    addPlane('roof', L, W, new THREE.Vector3(L / 2, H, W / 2), rx(Math.PI / 2));
    // Front (x=0) / back (x=L) walls: spanning W × H.
    addPlane('front', W, H, new THREE.Vector3(0, H / 2, W / 2), ry(Math.PI / 2));
    addPlane('back', W, H, new THREE.Vector3(L, H / 2, W / 2), ry(-Math.PI / 2));
    // Left (z=0) / right (z=W) walls: spanning L × H.
    addPlane('left', L, H, new THREE.Vector3(L / 2, H / 2, 0), null);
    addPlane('right', L, H, new THREE.Vector3(L / 2, H / 2, W), null);
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

    // Position/selection-only updates reuse label textures and geometry.
    const labelKey = JSON.stringify([p.name, p.category, p.hazmatClass, p.weight, p.color, d.l, d.w, d.h]);
    if (group.userData.labelKey === labelKey) return group;
    group.userData.labelKey = labelKey;
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
      this.disposeGroupContents(group);
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

  /**
   * Sync all meshes to a list of placements (add/update/remove). `selected`
   * may be a single placement id, an array of ids, or a Set — every matching
   * mesh is highlighted so multi-selected items all show as selected.
   */
  syncPlacements(placements, selected) {
    const selectedSet =
      selected instanceof Set
        ? selected
        : new Set(Array.isArray(selected) ? selected : selected ? [selected] : []);
    const seen = new Set();
    for (const p of placements) {
      this.upsertPlacement(p, selectedSet.has(p.id));
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

  setPendingVisible(v) {
    this.pendingGroup.visible = v;
  }

  /** Clear any measurement markers/line drawn by the Measure tool. */
  clearMeasureVisual() {
    this.disposeGroupContents(this.measureGroup);
    this.measureGroup.clear();
  }

  /**
   * Draw (or redraw) the current measurement: a small sphere marker at each
   * given point plus a connecting line. `dashed` renders a dashed preview
   * line (live drag before the second click is committed); otherwise a
   * solid line is drawn for the finalized measurement.
   */
  drawMeasureVisual(points, { dashed = false, color = 0xffc15c } = {}) {
    this.clearMeasureVisual();
    const markerGeo = new THREE.SphereGeometry(0.08, 12, 12);
    const markerMat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    for (const pt of points) {
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.copy(pt);
      marker.renderOrder = 999;
      this.measureGroup.add(marker);
    }
    if (points.length < 2) return;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    let line;
    if (dashed) {
      const mat = new THREE.LineDashedMaterial({
        color, depthTest: false, dashSize: 0.15, gapSize: 0.1, linewidth: 1,
      });
      line = new THREE.Line(lineGeo, mat);
      line.computeLineDistances();
    } else {
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 });
      line = new THREE.Line(lineGeo, mat);
    }
    line.renderOrder = 998;
    this.measureGroup.add(line);
  }

  /** Dispose geometry/material/texture for every mesh in a group's subtree. */
  disposeGroupContents(group) {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (material.map) material.map.dispose();
          material.dispose();
        }
      }
    });
  }

  /**
   * Lay out one box per remaining (unplaced) catalog unit in a grid beside
   * the container's long (length) side, so the user can preview what's next
   * to load without it reading as an extension of the short end wall.
   * `items` is an array of { name, dims:{l,w,h}, color } — one entry per
   * unplaced unit. As soon as a unit gets placed it should be omitted from
   * `items` by the caller, and it will disappear from this layout on the
   * next sync.
   */
  setPendingItems(items, spec) {
    this.disposeGroupContents(this.pendingGroup);
    this.pendingGroup.clear();
    if (!items || !items.length) return;

    const gap = 2; // feet between the container's long wall and the staging area
    const aisle = 1.5; // feet between staged items
    const startZ = spec.width + gap; // just past the long (length) side face
    const maxRowSpan = Math.max(spec.length, 10); // feet available per row along X

    let cursorX = 0;
    let cursorZ = startZ;
    let rowSpan = 0; // deepest item (in Z) placed in the current row

    for (const item of items) {
      const d = item.dims;
      // Wrap to a new row (further from the container, along Z) once the
      // current row along X (parallel to the container's length) is full.
      if (cursorX > 0 && cursorX + d.l > maxRowSpan) {
        cursorZ += rowSpan + aisle;
        cursorX = 0;
        rowSpan = 0;
      }

      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(item.color || '#4f8cff'),
        transparent: true,
        opacity: 0.6,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(d.l, d.h, d.w);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x101827 })
      );
      edges.scale.set(d.l, d.h, d.w);

      // Group is positioned in world space at the box's center; the mesh,
      // edges, and tag are all children placed relative to that center (i.e.
      // in local space), so the tag stays visually attached to its own box
      // regardless of that box's height.
      const group = new THREE.Group();
      group.position.set(cursorX + d.l / 2, d.h / 2, cursorZ + d.w / 2);
      group.add(mesh, edges);

      const tag = makeTagSprite(item.name, item.color || '#4f8cff');
      tag.position.set(0, d.h / 2 + 0.75, 0); // local: just above this box's top face
      group.add(tag);

      this.pendingGroup.add(group);

      cursorX += d.l + aisle;
      rowSpan = Math.max(rowSpan, d.w);
    }
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

  /**
   * Build the angled isometric perspective camera used for report snapshots.
   * Distance is derived from the container's bounding sphere and the
   * camera's vertical/horizontal FOV (fit-contain, with margin) so the whole
   * container — plus label stickers that project slightly past its faces —
   * is always fully visible and centered, regardless of container
   * proportions (e.g. 20' vs 40' vs high-cube) or the capture canvas's
   * aspect ratio. This mirrors the fit-contain approach already used by
   * makeOrthoCamera() for the elevation/plan views.
   */
  makeIsoCamera(L, W, H) {
    const fovDeg = 50;
    const aspect = this.canvasAspect();
    const cam = new THREE.PerspectiveCamera(fovDeg, aspect, 0.1, 5000);
    cam.up.set(0, 1, 0);

    const target = new THREE.Vector3(L / 2, H / 2, W / 2);
    // Bounding sphere radius that fully encloses the container volume (plus
    // a little slack for label stickers projecting past the box faces).
    const radius = Math.sqrt(L * L + W * W + H * H) / 2;
    const margin = 1.18; // breathing room, matching makeOrthoCamera's spirit

    const vFov = THREE.MathUtils.degToRad(fovDeg);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // Distance required to fit the sphere within each axis of the frustum;
    // take the larger so both dimensions clear fully (no cropping).
    const distV = radius / Math.sin(vFov / 2);
    const distH = radius / Math.sin(hFov / 2);
    const distance = Math.max(distV, distH) * margin;

    // Elevated three-quarter viewing direction (front-right-above), kept
    // consistent regardless of container size.
    const dir = new THREE.Vector3(0.62, 0.55, 0.86).normalize();
    cam.position.copy(target).addScaledVector(dir, distance);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    return cam;
  }

  /**
   * Capture one or more report views. Returns a map keyed by view name with
   * PNG data URLs. Views: 'iso', 'side', 'front', 'top', 'current' (the
   * live interactive camera's present orbit/zoom, exactly as the user last
   * left it — lets the user pick their own viewpoint for print-outs).
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
      // The user's own live orbit-camera angle/zoom, captured as-is.
      current: () => this.camera,
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
    this.controls.dispose();
    this.disposeGroupContents(this.scene);
    this.placementMeshes.clear();
    this.labelGroups.clear();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
