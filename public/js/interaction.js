// Pointer + keyboard interaction: select, drag (drops to the floor by default),
// Shift-click to build a multi-selection, rotate (R), tip (T), delete,
// dbl-click details.
//
// Multi-select + move-as-one: Shift-click toggles items in/out of a selection
// set. Plain-dragging any member of the set translates the whole set as a rigid
// group — every member keeps its relative position and height so the group
// moves as one, validated all-or-nothing against non-selected items. Delete and
// the nudge pad/arrow keys act on the whole set; rotate/tip/edit/details act on
// the primary (last-clicked) item.
import * as THREE from 'three';
import { activeScenario, catalogItem } from './store.js';
import { collidesAny, restingY } from './cargo.js';
import { toast } from './ui.js';

export class Interaction {
  constructor(sceneMgr, callbacks) {
    this.sm = sceneMgr;
    // callbacks: { onSelect(id,{toggle}), onChange, onEdit, onDetails, onDelete,
    //   onToggleLabels, getContainerSpec, getSelectedId, getSelectedIds }
    this.cb = callbacks;
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
      // Empty space: Shift-click keeps the current set (avoids accidental
      // clears while building a selection); a plain click clears it.
      if (!e.shiftKey) this.cb.onSelect(null);
      return;
    }
    const id = group.userData.placementId;
    const scenario = activeScenario();
    const placement = scenario?.placements.find((p) => p.id === id);
    if (!placement) return;

    const currentSet = this.getSelectedIds();
    const inMultiSelection = currentSet.length > 1 && currentSet.includes(id);

    // Shift decides between two actions based on whether the user drags:
    //   • Shift+click (no movement) → toggle this item in/out of the selection.
    //   • Shift+drag → classic "stack on item" for this single item.
    // We can't know which until pointerup, so begin a single-item stack-drag
    // now and remember to toggle the selection on release if nothing moved.
    if (e.shiftKey) {
      this.dragPlane.constant = -placement.y;
      this.raycaster.setFromCamera(this.pointer, this.sm.camera);
      const hit0 = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, hit0);
      this.dragging = {
        members: [{
          placement,
          offset: new THREE.Vector3(hit0.x - placement.x, 0, hit0.z - placement.z),
          lastValid: { x: placement.x, y: placement.y, z: placement.z },
        }],
        isGroup: false,
        stackMode: true,
        moveSet: new Set([id]),
        anchor: new THREE.Vector3(hit0.x, 0, hit0.z),
        moved: false,
        shiftToggleId: id, // toggle selection on pointerup if no drag occurs
      };
      return;
    }

    // Plain click. If the item is already part of a multi-selection, keep the
    // whole set and drag it as one group. Otherwise select just this item.
    if (!inMultiSelection) {
      this.cb.onSelect(id);
    }

    // Determine the group of placements to move. A single selection moves just
    // itself; a multi-selection moves every member together.
    const moveIds = inMultiSelection ? this.getSelectedIds() : [id];
    const members = moveIds
      .map((mid) => scenario.placements.find((p) => p.id === mid))
      .filter(Boolean);
    const isGroup = members.length > 1;

    // Begin drag on the horizontal plane at the primary item's base height.
    this.dragPlane.constant = -placement.y;
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.dragPlane, hit);
    // Anchor = pointer's XZ on the drag plane. Each member records its own
    // offset from the anchor so the group translates rigidly.
    this.dragging = {
      members: members.map((p) => ({
        placement: p,
        offset: new THREE.Vector3(hit.x - p.x, 0, hit.z - p.z),
        lastValid: { x: p.x, y: p.y, z: p.z },
      })),
      isGroup,
      // Single-item drags honor the classic Shift-to-stack behavior. Group
      // drags translate rigidly (each member keeps its height) so the set moves
      // "as one", so stackMode only applies to single-item drags.
      stackMode: isGroup ? false : e.shiftKey,
      moveSet: new Set(moveIds),
      anchor: new THREE.Vector3(hit.x, 0, hit.z),
      moved: false,
    };
  }

  /** Current multi-selection ids (falls back to the single selected id). */
  getSelectedIds() {
    if (this.cb.getSelectedIds) {
      const ids = this.cb.getSelectedIds();
      if (Array.isArray(ids)) return ids;
    }
    const one = this.cb.getSelectedId();
    return one ? [one] : [];
  }

  onMove(e) {
    if (!this.dragging) return;
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;

    if (this.dragging.isGroup) {
      this.moveGroup(hit);
    } else {
      this.moveSingle(hit);
    }
  }

  /** Single-item drag: floor by default, Shift settles on supports beneath. */
  moveSingle(hit) {
    const d = this.dragging.members[0];
    const p = d.placement;
    const spec = this.cb.getContainerSpec();
    let nx = hit.x - d.offset.x;
    let nz = hit.z - d.offset.z;
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
      d.lastValid = { x: p.x, y: p.y, z: p.z };
      this.dragging.moved = true;
    } else {
      // Keep the item at its last valid, non-overlapping pose.
      p.x = d.lastValid.x;
      p.y = d.lastValid.y;
      p.z = d.lastValid.z;
      p.layer = p.y <= 1e-6 ? 0 : 1;
    }
    this.sm.upsertPlacement(p, true);
  }

  /**
   * Group drag: translate every selected item rigidly by a single XZ delta,
   * preserving each member's relative position and height. The delta is clamped
   * so the group's bounding footprint stays inside the container, then the pose
   * is accepted only if no member collides with a non-selected item; otherwise
   * the whole group holds its last valid pose.
   */
  moveGroup(hit) {
    const spec = this.cb.getContainerSpec();
    const members = this.dragging.members;

    // Desired delta from the drag anchor, then clamp so no member leaves the
    // container footprint. We clamp the shared delta (not each item) so the
    // group stays rigid.
    let dx = hit.x - this.dragging.anchor.x;
    let dz = hit.z - this.dragging.anchor.z;
    for (const m of members) {
      const p = m.placement;
      const base = m.lastValid; // translate relative to the last valid pose
      dx = Math.max(-base.x, Math.min(dx, spec.length - p.dims.l - base.x));
      dz = Math.max(-base.z, Math.min(dz, spec.width - p.dims.w - base.z));
    }

    // Build candidate poses for the whole group at the clamped delta.
    const moveSet = this.dragging.moveSet;
    const others = activeScenario().placements.filter((o) => !moveSet.has(o.id));
    const candidates = members.map((m) => ({
      id: m.placement.id,
      catalogItemId: m.placement.catalogItemId,
      x: m.lastValid.x + dx,
      z: m.lastValid.z + dz,
      y: m.lastValid.y,
      dims: m.placement.dims,
    }));

    // Accept only if every member clears the non-selected items.
    const accepted = candidates.every((c) => !collidesAny(c, others));

    for (let i = 0; i < members.length; i++) {
      const p = members[i].placement;
      if (accepted) {
        const c = candidates[i];
        p.x = c.x;
        p.z = c.z;
        p.y = c.y;
        p.layer = p.y <= 1e-6 ? 0 : 1;
        members[i].lastValid = { x: p.x, y: p.y, z: p.z };
      } else {
        const lv = members[i].lastValid;
        p.x = lv.x;
        p.y = lv.y;
        p.z = lv.z;
        p.layer = p.y <= 1e-6 ? 0 : 1;
      }
      this.sm.upsertPlacement(p, true);
    }
    if (accepted && (dx !== 0 || dz !== 0)) this.dragging.moved = true;
  }

  onUp() {
    if (this.dragging) {
      if (this.dragging.moved) {
        // A Shift+drag that actually stacked a single item selects it (matching
        // the classic behavior) so state and highlight stay in sync.
        if (this.dragging.shiftToggleId) {
          this.cb.onSelect(this.dragging.shiftToggleId);
        }
        this.cb.onChange();
      } else if (this.dragging.shiftToggleId) {
        // Shift+click without a drag: toggle the item in the multi-selection.
        this.cb.onSelect(this.dragging.shiftToggleId, { toggle: true });
      }
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
    } else if (key === 'delete' || key === 'backspace') {
      // Delete every selected item (whole multi-selection), not just primary.
      const ids = this.getSelectedIds();
      if (!ids.length) return;
      e.preventDefault();
      for (const delId of ids) this.cb.onDelete(delId);
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
   * Apply a world-space translation {dx,dy,dz} (feet) to the whole selection,
   * reusing the same validation as dragging: clamp inside the container, reject
   * (and revert) if the result overlaps a non-selected item. The set moves as
   * one rigid unit — the delta is clamped so every member stays in-bounds and
   * the move is all-or-nothing. Commits + notifies on success so stats/panels
   * refresh.
   */
  nudgeSelected({ dx = 0, dy = 0, dz = 0 } = {}) {
    const scenario = activeScenario();
    if (!scenario) return;
    const ids = this.getSelectedIds();
    const members = ids
      .map((id) => scenario.placements.find((x) => x.id === id))
      .filter(Boolean);
    if (!members.length) return;

    const spec = this.cb.getContainerSpec();
    // Clamp the shared delta so no member leaves the container on any axis,
    // keeping the group rigid.
    let cdx = dx;
    let cdy = dy;
    let cdz = dz;
    for (const p of members) {
      cdx = Math.max(-p.x, Math.min(cdx, spec.length - p.dims.l - p.x));
      cdz = Math.max(-p.z, Math.min(cdz, spec.width - p.dims.w - p.z));
      cdy = Math.max(-p.y, Math.min(cdy, spec.height - p.dims.h - p.y));
    }

    // No effective movement (e.g. already flush against a wall): do nothing.
    if (cdx === 0 && cdy === 0 && cdz === 0) return;

    const moveSet = new Set(ids);
    const others = scenario.placements.filter((o) => !moveSet.has(o.id));

    // Apply the delta to a candidate pose for each member, then validate the
    // whole group against non-selected items.
    const candidates = members.map((p) => ({
      id: p.id,
      catalogItemId: p.catalogItemId,
      x: p.x + cdx,
      y: p.y + cdy,
      z: p.z + cdz,
      dims: p.dims,
    }));
    const blocked = candidates.some((c) => collidesAny(c, others));
    if (blocked) {
      // Nothing moved yet (we validated candidates), just warn and refresh.
      for (let i = 0; i < members.length; i++) this.sm.upsertPlacement(members[i], true);
      toast('Blocked — no room to move there', 'warn');
      return;
    }

    for (let i = 0; i < members.length; i++) {
      const p = members[i];
      const c = candidates[i];
      p.x = c.x;
      p.y = c.y;
      p.z = c.z;
      p.layer = p.y <= 1e-6 ? 0 : 1;
      this.sm.upsertPlacement(p, true);
    }
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
