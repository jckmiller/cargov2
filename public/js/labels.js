// 3D item tag/label "stickers" affixed flush to the box side faces.
import * as THREE from 'three';
import { fmtInches } from './container.js';

/** Draw the shipping-label content onto a canvas and return a texture. */
function makeLabelTexture(placement) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 640;
  canvas.height = 400;

  const lines = [
    placement.name,
    `${placement.category}${placement.hazmatClass && placement.hazmatClass !== 'none' ? ' · HZ ' + placement.hazmatClass : ''}`,
    `${Math.round(placement.weight)} lb`,
    `${fmtInches(placement.dims.l)} × ${fmtInches(placement.dims.w)} × ${fmtInches(placement.dims.h)}`,
  ];

  // White "paper" sticker with a thin colored frame.
  ctx.fillStyle = '#f7f9ff';
  roundRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 28);
  ctx.fill();
  ctx.strokeStyle = placement.color || '#4f8cff';
  ctx.lineWidth = 12;
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0f1420';
  ctx.font = 'bold 76px system-ui, sans-serif';
  ctx.fillText(clip(ctx, lines[0], canvas.width - 90), 50, 108);

  ctx.fillStyle = '#3a465f';
  ctx.font = '54px system-ui, sans-serif';
  ctx.fillText(clip(ctx, lines[1], canvas.width - 90), 50, 198);
  ctx.fillText(lines[2], 50, 272);
  ctx.font = '48px system-ui, sans-serif';
  ctx.fillText(lines[3], 50, 342);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build 4 sticker meshes (one per vertical side face) sized in LOCAL box space
 * where the box is centered at the origin with dimensions d = {l, w, h}.
 * Panels are inset to a fraction of each face so the box color frames them.
 */
export function makeLabelMeshes(placement, d) {
  const tex = makeLabelTexture(placement);
  const aspect = 640 / 400; // canvas W / H
  const EPS = 0.02; // push slightly off the surface to avoid z-fighting
  const cover = 0.85; // fraction of the face covered by the sticker
  const meshes = [];

  function panelFor(faceW, faceH) {
    let pw = faceW * cover;
    let ph = pw / aspect;
    if (ph > faceH * cover) {
      ph = faceH * cover;
      pw = ph * aspect;
    }
    const maxW = 9; // clamp for very large crates
    if (pw > maxW) {
      pw = maxW;
      ph = pw / aspect;
    }
    return { pw, ph };
  }

  // Size the sticker once using the most constraining side so all four
  // faces get an identical, uniformly legible label (no per-face mismatch).
  const wSide = panelFor(d.w, d.h);
  const lSide = panelFor(d.l, d.h);
  const uniform = wSide.pw <= lSide.pw ? wSide : lSide;

  function addPanel(faceW, faceH, position, rotationY) {
    const { pw, ph } = uniform;
    const geo = new THREE.PlaneGeometry(pw, ph);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.FrontSide,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    meshes.push(mesh);
  }

  const hl = d.l / 2;
  const hw = d.w / 2;

  // +X face: plane spans width (z) × height (y).
  addPanel(d.w, d.h, new THREE.Vector3(hl + EPS, 0, 0), Math.PI / 2);
  // -X face.
  addPanel(d.w, d.h, new THREE.Vector3(-hl - EPS, 0, 0), -Math.PI / 2);
  // +Z face: plane spans length (x) × height (y).
  addPanel(d.l, d.h, new THREE.Vector3(0, 0, hw + EPS), 0);
  // -Z face.
  addPanel(d.l, d.h, new THREE.Vector3(0, 0, -hw - EPS), Math.PI);

  return meshes;
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
