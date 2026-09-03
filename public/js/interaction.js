// Pointer + keyboard interaction: select, drag (drops to the floor by default),
// Shift-drag to stack on another item, rotate (R), tip (T), delete,
// dbl-click details.
import * as THREE from 'three';
import { activeScenario, catalogItem } from './store.js';
import { collidesAny, restingY } from './cargo.js';
import { toast } from './ui.js';

export class Interaction {
  constructor(sceneMgr, callbacks) {
    this.sm = sceneMgr;
    this.cb = callbacks; // { onSelect, onChange, onEdit, onDetails, getContainerSpec }
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragging = null; // { placement, group, offset }
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const dom = this.sm.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  setPointer(e) {
    const rect = this.sm.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  pickPlacement() {
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hits = this.raycaster.intersectObjects(this.sm.cargoGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.placementId) o = o.parent;
      if (o && o.userData.placementId) return o;
    }
    return null;
  }

  onDown(e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return; // plain left = drag; Ctrl/Cmd+left = orbit
    this.setPointer(e);
    const group = this.pickPlacement();
    if (!group) {
      this.cb.onSelect(null);
      return;
    }
    const id = group.userData.placementId;
    const scenario = activeScenario();
    const placement = scenario?.placements.find((p) => p.id === id);
    if (!placement) return;
    this.cb.onSelect(id);

    // Begin drag on the horizontal plane at the item's base height.
    this.dragPlane.constant = -placement.y;
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.dragPlane, hit);
    this.dragging = {
      placement,
      group,
      stackMode: e.shiftKey, // hold Shift to place on top of another item
      offset: new THREE.Vector3(
        hit.x - (placement.x + placement.dims.l / 2),
        0,
        hit.z - (placement.z + placement.dims.w / 2)
      ),
      moved: false,
      // Last known non-overlapping pose; drops that would overlap snap back here.
      lastValid: { x: placement.x, y: placement.y, z: placement.z },
    };
  }

  onMove(e) {
    if (!this.dragging) return;
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;

    const p = this.dragging.placement;
    const spec = this.cb.getContainerSpec();
    let nx = hit.x - this.dragging.offset.x - p.dims.l / 2;
    let nz = hit.z - this.dragging.offset.z - p.dims.w / 2;
    // Clamp inside container footprint.
    nx = Math.max(0, Math.min(nx, spec.length - p.dims.l));
    nz = Math.max(0, Math.min(nz, spec.width - p.dims.w));

    // Candidate pose at the pointer position.
    const candidate = { id: p.id, catalogItemId: p.catalogItemId, x: nx, z: nz, dims: p.dims, y: 0 };
    // Floor placement by default; Shift settles the item onto whatever is
    // under the pointer (honoring stacking rules) so it can be placed on top.
    const ny = this.dragging.stackMode ? this.computeStackY(candidate, spec) : 0;

    // Reject the move if the resting pose is invalid or would intersect
    // another item; snap back to the last valid pose instead of overlapping.
    let accepted = ny != null;
    if (accepted) {
      candidate.y = ny;
      const others = activeScenario().placements;
      if (collidesAny(candidate, others)) accepted = false;
    }

    if (accepted) {
      p.x = candidate.x;
      p.z = candidate.z;
      p.y = candidate.y;
      p.layer = p.y <= 1e-6 ? 0 : 1;
      this.dragging.lastValid = { x: p.x, y: p.y, z: p.z };
      this.dragging.moved = true;
    } else {
      // Keep the item at its last valid, non-overlapping pose.
      p.x = this.dragging.lastValid.x;
      p.y = this.dragging.lastValid.y;
      p.z = this.dragging.lastValid.z;
      p.layer = p.y <= 1e-6 ? 0 : 1;
    }
    this.sm.upsertPlacement(p, true);
  }

  onUp() {
    if (this.dragging && this.dragging.moved) {
      this.cb.onChange();
    }
    this.dragging = null;
  }

  /**
   * Resting Y for the dragged placement `p` — the lowest non-overlapping
   * height given the other items (auto-stack). Delegates to `restingY`, so the
   * item settles as close to the floor as possible rather than popping on top
   * of whatever it grazes. Returns null when no legal resting height exists
   * within the container (e.g. the resulting stack would exceed the container
   * height or hover on a forbidden base), so the caller can reject the move.
   */
  computeStackY(p, spec) {
    return restingY(
      p.x, p.z, p.dims,
      activeScenario().placements,
      spec,
      catalogItem(p.catalogItemId) || p,                       // topItem
      (o) => catalogItem(o.catalogItemId) || o,                // baseLookup
      p.id                                                      // skipId (exclude self)
    );
  }

  onDblClick(e) {
    this.setPointer(e);
    const group = this.pickPlacement();
    if (group) this.cb.onDetails(group.userData.placementId);
  }

  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const scenario = activeScenario();
    const id = this.cb.getSelectedId();
    const p = scenario?.placements.find((x) => x.id === id);
    const key = e.key.toLowerCase();

    // ---- Fine-tune move: nudge the selected item along the viewer's axes ----
    // Arrow keys move on the ground plane relative to the current camera view;
    // PageUp/PageDown move vertically. Default step is 1 inch; hold Alt for a
    // coarse 6 inch step. Directions are resolved against the live camera so
    // "left/right/up/down" always match what the user sees on screen.
    const NUDGE = { arrowleft: 'left', arrowright: 'right', arrowup: 'forward', arrowdown: 'back', pageup: 'up', pagedown: 'down' };
    if (NUDGE[key]) {
      if (!p) return;
      e.preventDefault();
      const step = (e.altKey ? 6 : 1) / 12; // feet (6" coarse, 1" fine)
      this.nudgeByView(NUDGE[key], step);
      return;
    }

    if (key === 'r' && p) {
      this.transformPlacement(p, (d) => ({
        dims: { l: d.w, w: d.l, h: d.h },
        rot: { ...(p.rot || {}), rot: ((p.rot?.rot || 0) + 90) % 360 },
      }), 'rotate');
    } else if (key === 't' && p) {
      this.transformPlacement(p, (d) => ({
        dims: { l: d.h, w: d.w, h: d.l },
        rot: { ...(p.rot || {}), tipped: !p.rot?.tipped },
      }), 'tip');
    } else if (key === 'e' && p) {
      this.cb.onEdit(id);
    } else if (key === 'l') {
      this.cb.onToggleLabels();
    } else if ((key === 'delete' || key === 'backspace') && p) {
      this.cb.onDelete(id);
    }
  }

  clampInside(p) {
    const spec = this.cb.getContainerSpec();
    p.x = Math.max(0, Math.min(p.x, spec.length - p.dims.l));
    p.z = Math.max(0, Math.min(p.z, spec.width - p.dims.w));
    if (p.y + p.dims.h > spec.height) p.y = Math.max(0, spec.height - p.dims.h);
  }

  /**
   * Resolve the two horizontal container axes ("right" and "forward") as seen
   * from the live camera. Each is the dominant world axis (±X = length, ±Z =
   * width) of the camera's screen-right and ground-projected view direction,
   * so nudging with the arrow keys/pad always tracks what the user sees.
   * Returns unit deltas: { right:{x,z}, forward:{x,z} }.
   */
  viewerAxes() {
    const cam = this.sm.camera;
    // Camera-right = first column of the world matrix.
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    right.y = 0;
    // Forward = where the camera looks, flattened onto the ground plane.
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;

    const snap = (v, fallback) => {
      if (v.lengthSq() < 1e-8) return fallback;
      // Snap to the dominant of the two horizontal axes.
      return Math.abs(v.x) >= Math.abs(v.z)
        ? { x: Math.sign(v.x) || 1, z: 0 }
        : { x: 0, z: Math.sign(v.z) || 1 };
    };
    return {
      right: snap(right, { x: 1, z: 0 }),
      forward: snap(forward, { x: 0, z: 1 }),
    };
  }

  /**
   * Nudge the selected item by `step` feet in a view-relative direction:
   * 'right' | 'left' | 'forward' | 'back' | 'up' | 'down'. Horizontal moves use
   * the camera-aligned axes; up/down use world height and float freely (bounded
   * only by the container and collisions).
   */
  nudgeByView(dir, step) {
    if (dir === 'up') return this.nudgeSelected({ dy: step });
    if (dir === 'down') return this.nudgeSelected({ dy: -step });
    const { right, forward } = this.viewerAxes();
    const sign = dir === 'left' || dir === 'back' ? -1 : 1;
    const axis = dir === 'right' || dir === 'left' ? right : forward;
    this.nudgeSelected({ dx: axis.x * step * sign, dz: axis.z * step * sign });
  }

  /**
   * Apply a world-space translation {dx,dy,dz} (feet) to the selected item,
   * reusing the same validation as dragging: clamp inside the container, reject
   * (and revert) if the result overlaps another item. Commits + notifies on
   * success so stats/panels refresh.
   */
  nudgeSelected({ dx = 0, dy = 0, dz = 0 } = {}) {
    const scenario = activeScenario();
    const p = scenario?.placements.find((x) => x.id === this.cb.getSelectedId());
    if (!p) return;

    const prev = { x: p.x, y: p.y, z: p.z };
    p.x += dx;
    p.y += dy;
    p.z += dz;
    this.clampInside(p);

    // No effective movement (e.g. already flush against a wall): do nothing.
    if (p.x === prev.x && p.y === prev.y && p.z === prev.z) return;

    if (collidesAny(p, scenario.placements)) {
      p.x = prev.x;
      p.y = prev.y;
      p.z = prev.z;
      this.sm.upsertPlacement(p, true);
      toast('Blocked — no room to move there', 'warn');
      return;
    }

    p.layer = p.y <= 1e-6 ? 0 : 1;
    this.sm.upsertPlacement(p, true);
    this.cb.onChange();
  }

  /**
   * Apply a reversible transform (rotate/tip) to a placement. The transform is
   * committed only if the result stays inside the container and does not
   * overlap any other item; otherwise it snaps back to the original pose.
   */
  transformPlacement(p, makeChange, label) {
    const prev = {
      dims: { ...p.dims },
      rot: { ...(p.rot || {}) },
      x: p.x,
      y: p.y,
      z: p.z,
    };
    const change = makeChange(prev.dims);
    p.dims = change.dims;
    p.rot = change.rot;
    this.clampInside(p);

    const others = activeScenario().placements;
    if (collidesAny(p, others)) {
      // Revert: not enough room for this orientation here.
      p.dims = prev.dims;
      p.rot = prev.rot;
      p.x = prev.x;
      p.y = prev.y;
      p.z = prev.z;
      this.sm.upsertPlacement(p, true);
      toast(`Not enough room to ${label} here`, 'warn');
      return;
    }
    this.sm.upsertPlacement(p, true);
    this.cb.onChange();
  }
}
