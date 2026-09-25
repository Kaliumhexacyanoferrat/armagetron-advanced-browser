// What this browser remembers: your name and colour, keys, camera, sound, and
// the admin tokens of the servers you created.

export const ACTIONS = {
  left: 'Turn left',
  right: 'Turn right',
  brake: 'Brake',
  glanceLeft: 'Glance left',
  glanceBack: 'Glance back',
  glanceRight: 'Glance right',
  view: 'Switch camera',
  chat: 'Chat',
  scores: 'Score table',
  spectate: 'Toggle spectator',
  map: 'Map mode',
  mute: 'Sound on/off',
};

// keys_cursor.cfg as the default, with keys_wasd.cfg's on top where they do not clash
export const DEFAULT_KEYS = {
  left: ['ArrowLeft', 'KeyA', 'KeyZ'],
  right: ['ArrowRight', 'KeyD', 'KeyX'],
  brake: ['ArrowDown', 'KeyS', 'Space'],
  glanceLeft: ['KeyQ', 'KeyJ'],
  glanceBack: ['KeyW', 'KeyK'],
  glanceRight: ['KeyE', 'KeyL'],
  view: ['KeyV', 'KeyN', 'KeyC'],
  chat: ['Enter', 'KeyT'],
  scores: ['Tab'],
  spectate: ['KeyB'],
  map: ['ShiftLeft'],
  mute: ['KeyM'],
};

const COLORS = [[15, 3, 3], [3, 15, 3], [3, 3, 15], [15, 15, 3]];

const STORE = 'armagetron.prefs';

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').replace(/[^a-z0-9]/g, '').slice(0, 20).padEnd(12, 'x');
}

export class Prefs {
  constructor() {
    const saved = load();
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    Object.assign(this, {
      name: '',
      r: color[0], g: color[1], b: color[2],
      cid: randomId(),
      keys: structuredClone(DEFAULT_KEYS),
      camera: 'custom',
      volume: 0.7,
      music: 0.35,
      mute: false,
      names: true,
      hud: true,
      clock: true,
      map: true,
      quality: 1,
      tokens: {},
    }, saved);
    this.keys = { ...structuredClone(DEFAULT_KEYS), ...(saved.keys ?? {}) };
    this.save();
  }

  save() {
    try {
      const { ...data } = this;
      localStorage.setItem(STORE, JSON.stringify(data));
    } catch {
      /* private mode: remember nothing */
    }
  }

  actionFor(code) {
    for (const [action, codes] of Object.entries(this.keys)) {
      if (codes.includes(code)) return action;
    }
    return null;
  }

  token(room) {
    return this.tokens[room] ?? null;
  }

  setToken(room, token) {
    this.tokens[room] = token;
    // forget servers long gone
    const entries = Object.entries(this.tokens);
    if (entries.length > 20) this.tokens = Object.fromEntries(entries.slice(-20));
    this.save();
  }
}

export function keyName(code) {
  if (!code) return '';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Arrow(.*)/, '$1 arrow')
    .replace('ShiftLeft', 'Left shift')
    .replace('ShiftRight', 'Right shift')
    .replace('ControlLeft', 'Left ctrl')
    .replace('Space', 'Space');
}
