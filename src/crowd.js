// crowd.js — the simulator's private world. Owns UE positions and moves them.
// Three drivers: manual drag (UI sets a target), walk-to-point (UI drops a dot),
// auto-drift (gentle wander), and chaos (radial dispersal from a burst point).

import { fromPolar, toPolar } from "./geometry.js";

const N_UES = 60;

function gaussian(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Crowd {
  constructor() {
    // start as one clustered crowd mid-sector
    const c = fromPolar(-10, 55);
    this.ues = Array.from({ length: N_UES }, () => {
      // each UE keeps a fixed offset from the group center, so the crowd holds
      // its ~7m-radius shape as it walks instead of collapsing onto one point
      const ox = gaussian(0, 7), oy = gaussian(0, 7);
      return { x: c.x + ox, y: c.y + oy, ox, oy };
    });
    this.mode = "auto";         // auto | walk | drag | chaos | split
    this.target = { ...c };     // where the crowd is heading (walk/drag)
    this.target2 = null;        // second target for split/allocate
    this.chaos = null;          // {x,y,t} burst origin + age
    this.speed = 3.2;           // m/tick baseline walking
  }

  setWalkTarget(x, y) { this.mode = "walk"; this.target = { x, y }; this.target2 = null; this.chaos = null; }
  setDrag(x, y)       { this.mode = "drag"; this.target = { x, y }; this.chaos = null; }
  setAuto()           { this.mode = "auto"; this.chaos = null; }
  setIdle()           { this.mode = "idle"; this.chaos = null; }
  split(x1, y1, x2, y2) { this.mode = "split"; this.target = { x: x1, y: y1 }; this.target2 = { x: x2, y: y2 }; this.chaos = null; }
  triggerChaos() {
    // burst origin = current crowd centroid
    const cx = this.ues.reduce((s, u) => s + u.x, 0) / this.ues.length;
    const cy = this.ues.reduce((s, u) => s + u.y, 0) / this.ues.length;
    this.mode = "chaos"; this.chaos = { x: cx, y: cy, t: 0 };
  }

  step() {
    if (this.mode === "idle") {
      // crowd holds position with tiny natural jitter
      for (const u of this.ues) { u.x += gaussian(0, 0.15); u.y += gaussian(0, 0.15); }
      this._clampSector();
      return;
    }

    if (this.mode === "chaos" && this.chaos) {
      this.chaos.t += 1;
      // each UE flees radially from the burst origin, speed rises then eases
      const boost = Math.min(6, 2 + this.chaos.t * 0.6);
      for (const u of this.ues) {
        let dx = u.x - this.chaos.x, dy = u.y - this.chaos.y;
        const d = Math.hypot(dx, dy) || 0.001;
        dx /= d; dy /= d;
        // small jitter so it looks organic, not a starburst
        const jx = gaussian(0, 0.4), jy = gaussian(0, 0.4);
        u.x += dx * boost + jx; u.y += dy * boost + jy;
      }
      this._clampSector();
      return;
    }

    if (this.mode === "split" && this.target2) {
      // half the crowd to target, half to target2
      this.ues.forEach((u, i) => {
        const t = (i % 2 === 0) ? this.target : this.target2;
        this._toward(u, t, this.speed);
      });
      this._clampSector();
      return;
    }

    if (this.mode === "auto") {
      // Pick a random direction, hold it for a randomized time (~1s +/-25% worth of ticks),
      // then switch to a new random direction. This gives clear "walk one way, then change".
      const tickMs = Number(process.env.TICK_MS || 2000);
      if (this.driftTicksLeft === undefined || this.driftTicksLeft <= 0) {
        this.driftHeading = Math.random() * Math.PI * 2;              // new random direction
        const holdMs = 1000 * (4 + Math.random() * 2);               // 5s +/-1s
        this.driftTicksLeft = Math.max(1, Math.round(holdMs / tickMs));
      }
      this.driftTicksLeft--;
      const driftSpeed = 2.0; // m/tick target travel
      this.target.x += Math.sin(this.driftHeading) * driftSpeed;
      this.target.y += Math.cos(this.driftHeading) * driftSpeed;
      // if we hit a sector boundary, steer the heading back toward the sector center
      // (mid-range, boresight) and commit to a fresh hold, so it doesn't stutter at the edge
      const tp = toPolar(this.target.x, this.target.y);
      if (tp.az < -42 || tp.az > 42 || tp.range < 42 || tp.range > 110) {
        const center = fromPolar(0, 70);               // sector middle
        this.driftHeading = Math.atan2(center.x - this.target.x, center.y - this.target.y)
                            + gaussian(0, 0.4);         // head back to center, slight randomness
        const tickMs2 = Number(process.env.TICK_MS || 2000);
        this.driftTicksLeft = Math.max(2, Math.round(1000 * (4 + Math.random() * 2) / tickMs2));
      }
      this._clampSector(this.target);
    }
    // walk/drag/auto: each UE eases toward (target + its formation offset),
    // so the crowd translates as a spread group and never collapses to a point
    for (const u of this.ues) {
      const ox = u.ox || 0, oy = u.oy || 0;
      this._toward(u, { x: this.target.x + ox, y: this.target.y + oy }, this.speed);
    }
    this._clampSector();
  }

  _toward(u, t, sp) {
    const dx = t.x - u.x, dy = t.y - u.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const move = Math.min(sp, d);
    // keep formation: add tiny cohesion noise
    u.x += (dx / d) * move + gaussian(0, 0.25);
    u.y += (dy / d) * move + gaussian(0, 0.25);
  }

  _clampSector(pt) {
    const clampOne = (o) => {
      let { az, range } = toPolar(o.x, o.y);
      az = Math.max(-54, Math.min(54, az));
      range = Math.max(12, Math.min(140, range));
      const p = fromPolar(az, range); o.x = p.x; o.y = p.y;
    };
    if (pt) { clampOne(pt); return; }
    for (const u of this.ues) clampOne(u);
  }

  snapshot() { return this.ues.map(u => ({ x: +u.x.toFixed(2), y: +u.y.toFixed(2) })); }
}