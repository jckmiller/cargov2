// Measure tool: click two points in the scene to read the distance between
// them (item-to-wall, item-to-roof, or any point A to point B), broken down
// into length/width/height deltas. Raycasts against both cargo meshes and
// the container's invisible boundary planes (see SceneManager.boundaryGroup)
// so "the wall" / "the roof" are always pickable even where no box sits.
//
// Modifiers on the SECOND click refine what's measured:
//   Shift  → lock B's X/Z to A (pure vertical distance — item to roof/floor)
//   Alt    → lock B's Y to A   (pure horizontal distance — item to a wall)
// Esc clears the current measurement; toggling the tool off also clears it.
import * as THREE from 'three';
import { fmtFeet } from './container.js';

export class MeasureTool {
  constructor(sceneMgr) {
    this.sm = sceneMgr;
    this.active = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointA = null; // THREE.Vector3 | null
    this.pointB = null; // THREE.Vector3 | null (finalized)

    this.readoutEl = document.getElementById('measure-readout');
    this.canvasWrapEl = document.getElementById('canvas-container');

    const dom = this.sm.renderer.domElement;
    this._onDown = (e) => this.onDown(e);
    this._onMove = (e) => this.onMove(e);
    this._onKey = (e) => this.onKey(e);
    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointermove', this._onMove);
    window.addEventListener('keydown', this._onKey);
  }

  isActive() {
    return this.active;
  }

  setActive(active) {
    this.active = active;
    this.sm.boundaryGroup.visible = false; // stays invisible; raycast works regardless
    if (this.canvasWrapEl) this.canvasWrapEl.classList.toggle('measuring', active);
    this.clear();
  }

  toggle() {
    this.setActive(!this.active);
    return this.active;
  }

  /** Clear the current measurement (both points, visuals, and HUD). */
  clear() {
    this.pointA = null;
    this.pointB = null;
    this.sm.clearMeasureVisual();
    this.renderReadout();
  }

  setPointer(e) {
    const rect = this.sm.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Raycast against cargo boxes first, then the container boundary planes. */
  pickPoint(e) {
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const cargoHits = this.raycaster.intersectObjects(this.sm.cargoGroup.children, true);
    if (cargoHits.length) return cargoHits[0].point.clone();
    const boundaryHits = this.raycaster.intersectObjects(this.sm.boundaryGroup.children, true);
    if (boundaryHits.length) return boundaryHits[0].point.clone();
    return null;
  }

  onDown(e) {
    if (!this.active || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const pt = this.pickPoint(e);
    if (!pt) return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.pointA || this.pointB) {
      // Start a fresh measurement.
      this.pointA = pt;
      this.pointB = null;
      this.sm.drawMeasureVisual([this.pointA]);
      this.renderReadout();
      return;
    }
    // Second click: finalize B (applying any axis lock).
    this.pointB = this.applyLock(pt, e);
    this.sm.drawMeasureVisual([this.pointA, this.pointB], { dashed: false });
    this.renderReadout();
  }

  onMove(e) {
    if (!this.active || !this.pointA || this.pointB) return;
    const pt = this.pickPoint(e);
    if (!pt) return;
    const b = this.applyLock(pt, e);
    this.sm.drawMeasureVisual([this.pointA, b], { dashed: true });
    this.renderReadout(b);
  }

  /** Shift locks B's horizontal position to A (vertical-only); Alt locks B's height to A (horizontal-only). */
  applyLock(pt, e) {
    const b = pt.clone();
    if (e.shiftKey) {
      b.x = this.pointA.x;
      b.z = this.pointA.z;
    } else if (e.altKey) {
      b.y = this.pointA.y;
    }
    return b;
  }

  onKey(e) {
    if (!this.active) return;
    if (e.key === 'Escape') {
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      this.clear();
    }
  }

  /** Render the HUD readout. `livePoint` is the still-hovering (unfinalized) B, if any. */
  renderReadout(livePoint) {
    const host = this.readoutEl;
    if (!host) return;
    const a = this.pointA;
    const b = this.pointB || livePoint;
    if (!this.active || !a) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    host.classList.remove('hidden');
    if (!b) {
      host.innerHTML = `<div class="m-hint">Click a second point to measure (Shift = vertical only, Alt = horizontal only)</div>`;
      return;
    }
    const dx = Math.abs(b.x - a.x); // length axis
    const dz = Math.abs(b.z - a.z); // width axis
    const dy = Math.abs(b.y - a.y); // height axis
    const total = a.distanceTo(b);
    host.innerHTML = `
      <div class="m-total">${fmtFeet(total)}</div>
      <div class="m-row"><span class="k">Length (Δ)</span><span>${fmtFeet(dx)}</span></div>
      <div class="m-row"><span class="k">Width (Δ)</span><span>${fmtFeet(dz)}</span></div>
      <div class="m-row"><span class="k">Height (Δ)</span><span>${fmtFeet(dy)}</span></div>
      <div class="m-hint">${this.pointB ? 'Click to start a new measurement (Esc clears)' : 'Click to lock this point'}</div>
    `;
  }

  dispose() {
    const dom = this.sm.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onDown);
    dom.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('keydown', this._onKey);
    this.clear();
  }
}
