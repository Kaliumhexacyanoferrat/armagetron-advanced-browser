// The cameras of src/engine/eCamera.cpp with their default settings
// (config/settings_visual.cfg). Custom is where everybody starts: behind and
// above the cycle, further out the faster it goes, turning after it smoothly.
// SWITCH_VIEW cycles Custom -> In -> Mer -> Smart -> Follow -> Free.

export const MODES = ['custom', 'in', 'mer', 'smart', 'follow', 'free'];

export const MODE_NAMES = {
  custom: 'Custom camera', in: 'Internal camera', mer: 'Meriton camera',
  smart: 'Smart camera', follow: 'Fixed camera', free: 'Free camera',
};

export class Camera {
  constructor() {
    this.mode = 'custom';
    this.eye = [0, 0, 20];
    this.target = [1, 1, 0];
    this.fov = 90;
    this.dir = [0, 1];          // where the camera looks, on the floor
    this.speedSmooth = 20;
    this.glance = null;         // 'left' | 'right' | 'back' | null
    this.glanceDir = null;
    this.followOffset = null;
    this.free = { x: 0, y: 0, z: 60, yaw: Math.PI / 4, pitch: -0.9 };
    this.lastFocus = null;
    this.pitchIn = -0.08;
  }

  setMode(mode) {
    this.mode = mode;
    this.followOffset = null;
  }

  next() {
    const i = MODES.indexOf(this.mode);
    this.setMode(MODES[(i + 1) % MODES.length]);
    return this.mode;
  }

  // focus: { x, y, dx, dy, speed } of the watched cycle, or null
  update(dt, focus, size, input) {
    dt = Math.min(dt, 0.1);
    if (!focus) {
      this.overview(dt, size, input);
      return;
    }
    const dx = focus.dx, dy = focus.dy;

    // the wanted look direction: the cycle's, or a glance to the side or back
    let want = [dx, dy];
    if (this.glance === 'left') want = [-dy, dx];
    else if (this.glance === 'right') want = [dy, -dx];
    else if (this.glance === 'back') want = [-dx, -dy];

    const turn = (rate) => {
      const cos = this.dir[0] * want[0] + this.dir[1] * want[1];
      if (cos < -0.5 && this.glance) {
        // more than 120 degrees away: snap (CAMERA_GLANCE_SNAP)
        this.dir = [...want];
        return;
      }
      if (this.glance || this.returning) {
        // glances turn at a constant 4 pi per second
        const cur = Math.atan2(this.dir[1], this.dir[0]);
        const goal = Math.atan2(want[1], want[0]);
        let diff = goal - cur;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const step = 4 * Math.PI * dt;
        const a = Math.abs(diff) <= step ? goal : cur + Math.sign(diff) * step;
        this.dir = [Math.cos(a), Math.sin(a)];
        if (!this.glance && Math.abs(diff) <= step) this.returning = false;
        return;
      }
      let x = this.dir[0] + want[0] * rate * dt, y = this.dir[1] + want[1] * rate * dt;
      if (cos < 0) {
        // facing backwards: an extra push towards the driving direction (TURN_SPEED_180)
        x += want[0] * 4 * dt;
        y += want[1] * 4 * dt;
      }
      const l = Math.hypot(x, y);
      if (l < 1e-6) {
        this.dir = [...want];
      } else {
        this.dir = [x / l, y / l];
      }
    };

    this.speedSmooth = (this.speedSmooth + focus.speed * dt) / (1 + dt);
    const s = this.speedSmooth;

    switch (this.mode) {
      case 'custom': {
        turn(4);
        const back = 6 + 0.5 * s, rise = 4 + 0.4 * s;
        this.eye = [focus.x - this.dir[0] * back, focus.y - this.dir[1] * back, 0.75 + rise];
        this.target = [this.eye[0] + this.dir[0], this.eye[1] + this.dir[1], this.eye[2] - 0.58];
        break;
      }
      case 'in': {
        turn(40);
        this.eye = [focus.x, focus.y, 0.75];
        this.target = [focus.x + this.dir[0], focus.y + this.dir[1], 0.75 + this.pitchIn];
        break;
      }
      case 'mer': {
        // on the line from the cycle to the camera, 20 away, 16 up
        let ox = this.eye[0] - focus.x, oy = this.eye[1] - focus.y;
        const l = Math.hypot(ox, oy);
        if (l < 1e-3 || this.lastMode !== 'mer') {
          ox = -dx; oy = -dy;
        } else {
          ox /= l; oy /= l;
        }
        this.eye = [focus.x + ox * 20, focus.y + oy * 20, 16];
        this.target = [focus.x, focus.y, 0.5];
        break;
      }
      case 'smart': {
        // lags behind, rises when things get fast, looks a little ahead
        turn(2.5);
        const back = Math.max(s * 0.25, 5), rise = 2 + s * 0.08;
        const ex = focus.x - this.dir[0] * back, ey = focus.y - this.dir[1] * back;
        const k = Math.min(1, 6 * dt);
        this.eye = [this.eye[0] + (ex - this.eye[0]) * k, this.eye[1] + (ey - this.eye[1]) * k, this.eye[2] + (rise - this.eye[2]) * k];
        this.target = [focus.x + dx * 3, focus.y + dy * 3, 0.5];
        break;
      }
      case 'follow': {
        if (!this.followOffset) {
          // (-30, -30, 80) in the cycle's frame when the camera was chosen, then fixed
          this.followOffset = [-30 * dx + 30 * dy, -30 * dy - 30 * dx, 80];
        }
        this.eye = [focus.x + this.followOffset[0], focus.y + this.followOffset[1], this.followOffset[2]];
        this.target = [focus.x, focus.y, 0];
        break;
      }
      case 'free':
      default:
        this.freeCamera(dt, input, focus);
        break;
    }
    this.lastMode = this.mode;
    this.lastFocus = focus;
  }

  setGlance(g) {
    if (!g && this.glance) this.returning = true;
    this.glance = g;
  }

  // nobody to watch: circle the arena slowly
  overview(dt, size, input) {
    if (this.mode === 'free' && input) {
      this.freeCamera(dt, input, null);
      return;
    }
    this.orbit = (this.orbit ?? 0) + dt * 0.08;
    const c = size / 2;
    const r = size * 0.55;
    this.eye = [c + Math.cos(this.orbit) * r, c + Math.sin(this.orbit) * r, size * 0.35];
    this.target = [c, c, 0];
    this.lastMode = null;
  }

  // FREE: fly with the arrow keys, page up/down to rise and sink
  freeCamera(dt, input, focus) {
    const f = this.free;
    if (this.lastMode !== 'free' && focus) {
      f.x = focus.x - focus.dx * 20;
      f.y = focus.y - focus.dy * 20;
      f.z = 25;
      f.yaw = Math.atan2(focus.dy, focus.dx);
      f.pitch = -0.6;
    }
    if (input) {
      const speed = 40 * dt;
      if (input.forward) { f.x += Math.cos(f.yaw) * speed; f.y += Math.sin(f.yaw) * speed; }
      if (input.backward) { f.x -= Math.cos(f.yaw) * speed; f.y -= Math.sin(f.yaw) * speed; }
      if (input.left) f.yaw += 1.5 * dt;
      if (input.right) f.yaw -= 1.5 * dt;
      if (input.up) f.z += speed;
      if (input.down) f.z = Math.max(1, f.z - speed);
    }
    this.eye = [f.x, f.y, f.z];
    this.target = [f.x + Math.cos(f.yaw), f.y + Math.sin(f.yaw), f.z + f.pitch];
    this.lastMode = 'free';
  }
}
