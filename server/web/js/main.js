// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The application: the front page or a game, the socket, the frame loop,
// keys and menus.

import { Net } from './net.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { Camera, MODES, MODE_NAMES } from './camera.js';
import { Hud, strip, paint, hex15 } from './hud.js';
import { Audio } from './audio.js';
import { Prefs, ACTIONS, DEFAULT_KEYS, keyName } from './prefs.js';
import { Lobby, buildRuleFields, readRuleFields } from './lobby.js';
import { navigate } from './menunav.js';

class App {
  constructor() {
    this.prefs = new Prefs();
    this.net = new Net();
    this.audio = new Audio(this.prefs);
    this.lobby = new Lobby(this);
    this.gameEl = document.getElementById('game');
    this.hud = new Hud(this.gameEl, this.prefs);
    this.camera = new Camera();
    this.camera.setMode(MODES.includes(this.prefs.camera) ? this.prefs.camera : 'custom');
    this.game = null;
    this.room = null;
    this.players = [];
    this.watch = null;          // the cycle we look at while not riding
    this.deathAt = null;
    this.chatting = new Set();
    this.countdown = null;
    this.fps = 60;

    // Cancel and Close buttons are no submit buttons, so Enter in a field presses the main one
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close('cancel');
    });
    // every dialog works with the arrow keys
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('keydown', (e) => {
        if (!this.binding) navigate(dialog, e);
      });
    }

    this.wire();
    this.setupInput();
    this.setupMenu();
    this.setupSettings();
    this.setupAdmin();

    // browsers start sound (and the title music) only after a click or a key
    const first = () => {
      this.audio.unlock();
      window.removeEventListener('pointerdown', first, true);
      window.removeEventListener('keydown', first, true);
    };
    window.addEventListener('pointerdown', first, true);
    window.addEventListener('keydown', first, true);

    this.net.connect();
    this.lobby.show();
    this.audio.playMusic('title');
    this.lobby.online(null);
  }

  hello() {
    const p = this.prefs;
    this.net.send({ t: 'hello', name: p.name || '', r: p.r, g: p.g, b: p.b, cid: p.cid });
  }

  // -------------------------------------------------------------------
  // The socket

  wire() {
    const net = this.net;

    net.on('open', () => {
      this.hello();
      if (this.room) {
        // back after losing the connection: into the same server again
        this.hud.status('');
        this.join(this.room, this.password);
      } else if (this.pending) {
        this.join(this.pending, this.password);
      } else {
        const wanted = location.hash.match(/^#\/?([a-z0-9]{4,12})$/);
        if (wanted) this.join(wanted[1]);
        else net.send({ t: 'list' });
      }
    });

    net.on('close', () => {
      this.lobby.online(null);
      if (this.room) this.hud.status(`Connection lost. Reconnecting${this.net.retry > 1 ? ` (attempt ${this.net.retry})` : ''}...`);
    });

    net.on('rooms', (m) => this.lobby.setRooms(m.rooms, m.total));

    net.on('created', (m) => {
      this.prefs.setToken(m.room, m.token);
      this.join(m.room);
    });

    net.on('refused', (m) => {
      if (m.code === 'password') {
        this.askPassword(this.pending, m.reason);
        return;
      }
      const inGame = !!this.room;
      this.room = null;
      this.pending = null;
      if (inGame) this.showLobby();
      history.replaceState(null, '', location.pathname);
      this.notice('Could not join', m.reason);
    });

    net.on('joined', (m) => this.enter(m));

    net.on('state', (m) => {
      if (!this.game) return;
      this.game.load(m);
      this.onRoundLoaded(m);
    });

    net.on('sync', (m) => this.game?.onSync(m));
    net.on('turn', (m) => this.game?.onTurn(m));
    net.on('brake', (m) => this.game?.onBrake(m));
    net.on('die', (m) => this.game?.onDie(m));

    net.on('msg', (m) => this.hud.message(m.text));
    net.on('center', (m) => this.hud.showCenter(m.text, m.duration));
    net.on('phase', (m) => {
      if (this.game) this.game.phase = m.phase;
      if (m.phase === 'over') {
        this.hud.showScores(true);
        this.hud.renderScores(this.players, this.you);
      }
    });

    net.on('players', (m) => {
      this.players = m.list;
      this.playersChanged();
    });

    // just what changed since the last list: [id, score, kills, alive, chatting]
    net.on('pc', (m) => {
      for (const [id, score, kills, alive, chatting] of m.c) {
        const p = this.players.find((x) => x.id === id);
        if (p) Object.assign(p, { score, kills, alive: !!alive, chatting: !!chatting });
      }
      // the server's order: the best first, spectators last among equals
      this.players.sort((a, b) => b.score - a.score || a.spectator - b.spectator);
      this.playersChanged();
    });

    net.on('settings', (m) => {
      this.settings = m.settings;
    });

    net.on('bans', (m) => this.renderBans(m.bans));

    net.on('kicked', (m) => {
      this.room = null;
      this.showLobby();
      history.replaceState(null, '', location.pathname);
      this.notice('You left the server', m.reason);
    });

    net.on('bye', (m) => {
      if (m.reason) this.notice('Disconnected', m.reason);
    });

    net.on('welcome', () => {
      this.lobby.online(null);
      fetch('api/servers').then((r) => r.json()).then((s) => this.lobby.online(s.online)).catch(() => {});
    });
  }

  playersChanged() {
    this.chatting = new Set(this.players.filter((p) => p.chatting).map((p) => p.id));
    this.hud.renderScores(this.players, this.you);
    if (this.adminOpen) this.renderAdminPlayers();
    this.updateMenu();
  }

  join(room, password) {
    this.audio.unlock();
    this.pending = room;
    this.password = password;
    this.net.send({ t: 'join', room, token: this.prefs.token(room), password });
  }

  askPassword(room, reason) {
    const dialog = document.getElementById('password');
    document.getElementById('password-text').textContent = reason;
    const input = document.getElementById('password-input');
    input.value = '';
    dialog.returnValue = '';
    dialog.onclose = () => {
      if (dialog.returnValue === 'ok' && input.value) this.join(room, input.value);
    };
    dialog.showModal();
  }

  notice(title, text) {
    const dialog = document.getElementById('notice');
    document.getElementById('notice-title').textContent = title;
    document.getElementById('notice-text').textContent = strip(text);
    if (!dialog.open) dialog.showModal();
  }

  // we are in: from the front page to the grid
  enter(m) {
    this.room = m.room;
    this.pending = null;
    this.you = m.you;
    this.admin = m.admin;
    this.settings = m.settings;
    this.owner = m.owner;
    if (m.token) this.prefs.setToken(m.room, m.token);
    history.replaceState(null, '', `#/${m.room}`);

    this.game = new Game(this.net);
    this.game.you = m.you;
    this.game.on('turn', (c) => {
      if (this.game.world) this.audio.positional('turn', this.camera, c.x, c.y, 4 * 60 / 128);
    });
    this.game.on('die', (c, killer) => this.onDeath(c, killer));

    this.watch = null;
    this.deathAt = null;
    this.hud.lines = [];
    this.hud.renderConsole();
    this.hud.clearTags();
    this.hud.showScores(false);
    this.hud.status('');

    this.lobby.hide();
    this.gameEl.hidden = false;
    document.getElementById('menu-title').textContent = strip(m.settings.name);
    document.getElementById('menu-admin-item').hidden = !m.admin;
    try {
      if (!this.renderer) {
        const view = document.getElementById('view');
        this.renderer = new Renderer(view);
        // the graphics driver may take the context away (a reset, too many tabs): build again when it is back
        view.addEventListener('webglcontextlost', (e) => e.preventDefault());
        view.addEventListener('webglcontextrestored', () => {
          this.renderer = new Renderer(view);
          this.renderer.scale = this.prefs.quality;
        });
      }
    } catch (e) {
      this.leave();
      this.notice('No 3D graphics', `This browser cannot show the game: ${e.message} Try another browser, or turn on hardware acceleration.`);
      return;
    }
    this.renderer.scale = this.prefs.quality;
    this.audio.playMusic('game');
    if (!this.running) {
      // a reconnect enters again: one frame loop is enough
      this.running = true;
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  showLobby() {
    this.running = false;
    this.game = null;
    this.players = [];
    this.chatting = new Set();
    this.spectateWish = undefined;
    this.closeChat(false);
    this.gameEl.hidden = true;
    this.closeMenu();
    this.audio.silence();
    this.audio.playMusic('title');
    this.lobby.show();
  }

  leave() {
    this.net.send({ t: 'leave' });
    this.room = null;
    history.replaceState(null, '', location.pathname);
    this.showLobby();
  }

  onRoundLoaded(m) {
    this.hud.showScores(m.phase === 'over');
    this.hud.clearTags();
    this.deathAt = null;
    this.watch = null;
    this.hud.maxSpeed = 0;
    this.spawnDir = null;
    const own = this.game.own;
    if (own) this.spawnDir = [own.dx, own.dy];
    this.renderer?.reset();
    if (m.phase === 'countdown') {
      // somebody joining during the countdown sends the round again: do not count twice
      if (this.countdown?.start !== m.start) this.countdown = { start: m.start, said: new Set() };
      this.hud.showScores(false);
    } else {
      this.countdown = null;
    }
    // the camera starts behind the cycle, looking where it goes
    const focus = own ?? [...this.game.world.cycles.values()][0];
    if (focus) this.camera.dir = [focus.dx, focus.dy];
    this.camera.followOffset = null;
  }

  onDeath(c, killer) {
    const { x, y } = c;
    this.audio.positional('explosion', this.camera, x, y, 4);
    if (c.id === this.you) {
      this.deathAt = { time: performance.now(), x, y, dx: c.dx, dy: c.dy, killer };
      if (this.camera.mode === 'in') {
        // the internal camera jumps back and up at a crash
        this.camera.setMode(this.prefs.camera === 'in' ? 'custom' : this.prefs.camera);
      }
    }
    if (this.watch === c.id) this.watchNext(0, killer);
  }

  // -------------------------------------------------------------------
  // The frame

  frame(t) {
    if (!this.running) return;
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.25, (t - this.last) / 1000);
    this.last = t;
    if (dt > 0) this.fps = this.fps * 0.95 + (1 / dt) * 0.05;

    const game = this.game;
    const serverNow = this.net.serverNow(dt);
    game.update(serverNow);

    this.tickCountdown(serverNow);

    // whom we look at: ourselves, the killer for a while, or whoever is left
    const own = game.own;
    let focusCycle = null;
    if (own && own.alive) {
      focusCycle = own;
    } else if (game.world) {
      if (this.deathAt && performance.now() - this.deathAt.time < 4000) {
        focusCycle = null;
      } else {
        let w = this.watch !== null ? game.world.cycles.get(this.watch) : null;
        if (!w || !w.alive) {
          this.watchNext(0, this.deathAt?.killer);
          w = this.watch !== null ? game.world.cycles.get(this.watch) : null;
        }
        focusCycle = w && w.alive ? w : null;
      }
    }

    let focus = null;
    if (focusCycle) {
      const d = game.display(focusCycle, serverNow);
      focus = { x: d.x, y: d.y, dx: focusCycle.dx, dy: focusCycle.dy, speed: focusCycle.frozen ? 0 : focusCycle.speed() };
    } else if (this.deathAt && performance.now() - this.deathAt.time < 4000) {
      focus = { x: this.deathAt.x, y: this.deathAt.y, dx: this.deathAt.dx, dy: this.deathAt.dy, speed: 0 };
    }

    const size = game.world?.map.size ?? 177;
    this.camera.focus = focus;
    this.camera.update(dt, focus, size, focus && own?.alive ? null : this.freeInput);

    const scene = {
      world: game.world,
      names: game.names,
      display: (c) => game.display(c, serverNow),
      explosions: game.explosions,
      hide: this.camera.mode === 'in' && focusCycle ? focusCycle.id : null,
      chatting: this.chatting,
    };
    this.renderer.draw(scene, this.camera, serverNow, dt);
    if (game.explosions.length && serverNow - game.explosions[0].time >= 4) {
      game.explosions = game.explosions.filter((e) => serverNow - e.time < 4);
    }

    // the cockpit shows the watched cycle
    const alive = game.world ? [...game.world.cycles.values()].filter((c) => c.alive) : [];
    let fastest = null;
    for (const c of alive) {
      const s = c.speed();
      if (!fastest || s > fastest.speed) fastest = { name: game.names.get(c.id)?.name ?? '', speed: s };
    }
    const me = this.players.find((p) => p.id === this.you);
    const others = this.players.filter((p) => p.id !== this.you && !p.spectator);
    this.hud.draw({
      game,
      cycle: focusCycle,
      settings: game.settings ?? { rubber: 1 },
      showCockpit: !!focusCycle && this.camera.mode !== 'in',
      fastest,
      ping: Math.round(this.net.rtt * 1000),
      enemies: alive.filter((c) => c.id !== this.you).length,
      myScore: me?.score ?? 0,
      topScore: others.length ? Math.max(...others.map((p) => p.score)) : 0,
      fps: this.fps,
      time: serverNow,
      focus,
      spawnDir: this.spawnDir,
      cameraDir: this.camera.dir,
      chatting: false,
      song: this.audio.song,
    });
    this.hud.nameTags(game, this.renderer, performance.now(), focusCycle?.id ?? this.you);
    this.audio.speedMultiplier = Math.pow(2, (this.settings?.speedFactor ?? 0) / 2);
    this.audio.engines_(alive.map((c) => {
      const d = game.display(c, serverNow);
      return { id: c.id, x: d.x, y: d.y, speed: c.frozen ? 0 : c.speed(), frozen: c.frozen };
    }), this.camera, this.you, dt);

    // what you are doing, when not riding
    if (!this.net.open) {
      // the reconnect message stays
    } else if (game.phase === 'idle' && !own) {
      this.hud.status(this.isSpectator() ? 'You are watching. Press B to play.' : 'Waiting for the next round...');
    } else if (!own && game.world && game.phase !== 'idle') {
      const w = focusCycle ? strip(game.names.get(focusCycle.id)?.name ?? '') : null;
      this.hud.status(this.isSpectator()
        ? (w ? `Watching ${w}. ← → to switch, B to play.` : 'You are watching. Press B to play.')
        : (w ? `Watching ${w}. You join the next round.` : 'You join the next round.'));
    } else if (own && !own.alive && focusCycle) {
      this.hud.status(`Watching ${strip(game.names.get(focusCycle.id)?.name ?? '')}. ← → to switch.`);
    } else {
      this.hud.status('');
    }
  }

  isSpectator() {
    return !!this.players.find((p) => p.id === this.you)?.spectator;
  }

  // switch the watched cycle: the killer first, then round the others
  watchNext(step, prefer) {
    const game = this.game;
    if (!game?.world) return;
    const alive = [...game.world.cycles.values()].filter((c) => c.alive && c.id !== this.you);
    if (!alive.length) {
      this.watch = null;
      return;
    }
    if (prefer !== undefined && prefer !== null && alive.some((c) => c.id === prefer)) {
      this.watch = prefer;
      return;
    }
    const i = alive.findIndex((c) => c.id === this.watch);
    this.watch = alive[((i < 0 ? 0 : i + step) + alive.length) % alive.length].id;
  }

  // 3, 2, 1 and the announcer (PREPARE_TIME 4)
  tickCountdown(serverNow) {
    const cd = this.countdown;
    if (!cd) return;
    const t = serverNow - cd.start;
    const n = Math.floor(-t) + 1;
    if (t > 0) {
      if (!cd.said.has(0)) {
        cd.said.add(0);
        this.audio.play('go', 0.9);
        this.hud.showCenter('GO!', 0);
      }
      if (t > 1.5) this.countdown = null;
      return;
    }
    if (n >= 1 && n <= 3 && !cd.said.has(n)) {
      cd.said.add(n);
      this.audio.play(['', 'one', 'two', 'three'][n], 0.9);
      this.hud.showCenter(String(n), 0);
    }
  }

  // -------------------------------------------------------------------
  // Keys

  setupInput() {
    this.freeInput = { forward: false, backward: false, left: false, right: false, up: false, down: false };
    const held = new Set();

    const typing = () => {
      const a = document.activeElement;
      return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') || document.querySelector('dialog[open]');
    };

    window.addEventListener('keydown', (e) => {
      if (this.binding) return;
      if (!this.room || this.gameEl.hidden) return;
      // a dialog handles its own keys (Escape closes it)
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'Escape') {
        if (!this.chatEl().hidden) this.closeChat();
        else this.toggleMenu();
        e.preventDefault();
        return;
      }
      if (typing() || !document.getElementById('menu').hidden) return;
      this.audio.unlock();

      const free = this.freeKeys(e.code, true);
      const action = this.prefs.actionFor(e.code);
      if (!action) {
        if (free) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (e.repeat && action !== 'brake') return;
      held.add(e.code);
      this.act(action, true);
    });

    window.addEventListener('keyup', (e) => {
      this.freeKeys(e.code, false);
      const action = this.prefs.actionFor(e.code);
      if (!action || !held.has(e.code)) return;
      held.delete(e.code);
      this.act(action, false);
    });

    window.addEventListener('blur', () => {
      held.clear();
      for (const k of Object.keys(this.freeInput)) this.freeInput[k] = false;
      this.game?.brake(false);
      this.camera.setGlance(null);
    });

    const chat = this.chatEl();
    chat.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (text) this.net.send({ t: 'chat', text });
      this.closeChat(false);
    });

    // touch screens: the lower third turns and brakes
    if (matchMedia('(pointer: coarse)').matches) {
      const touch = document.getElementById('touch');
      touch.hidden = false;
      touch.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        e.preventDefault();
        this.audio.unlock();
        const a = b.dataset.touch;
        if (a === 'brake') {
          // the release counts wherever the finger lifts
          b.setPointerCapture(e.pointerId);
          this.act('brake', true);
        } else {
          this.act(a, true);
        }
      });
      const release = (e) => {
        if (e.target.closest?.('button')?.dataset.touch === 'brake') this.act('brake', false);
      };
      touch.addEventListener('pointerup', release);
      touch.addEventListener('pointercancel', release);
      this.gameEl.addEventListener('dblclick', () => this.toggleMenu());
    }

    this.gameEl.addEventListener('mousemove', () => {
      this.gameEl.classList.add('pointer');
      clearTimeout(this.pointerTimer);
      this.pointerTimer = setTimeout(() => this.gameEl.classList.remove('pointer'), 1500);
    });
  }

  freeKeys(code, down) {
    const map = { ArrowUp: 'forward', ArrowDown: 'backward', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'up', PageDown: 'down' };
    const k = map[code];
    if (!k) return false;
    this.freeInput[k] = down;
    return this.camera.mode === 'free';
  }

  act(action, down) {
    const game = this.game;
    const own = game?.own;
    const riding = own && own.alive;
    switch (action) {
      case 'left':
      case 'right':
        if (!down) return;
        if (riding) game.turn(action === 'left' ? 1 : -1);
        else if (this.camera.mode !== 'free') this.watchNext(action === 'left' ? -1 : 1);
        return;
      case 'brake':
        if (riding) game.brake(down);
        return;
      case 'glanceLeft':
        this.camera.setGlance(down ? 'left' : null);
        return;
      case 'glanceRight':
        this.camera.setGlance(down ? 'right' : null);
        return;
      case 'glanceBack':
        this.camera.setGlance(down ? 'back' : null);
        return;
      case 'view':
        if (!down) return;
        this.camera.next();
        this.prefs.camera = this.camera.mode;
        this.prefs.save();
        this.hud.message(`0xffff7f${MODE_NAMES[this.camera.mode]}`);
        this.updateMenu();
        return;
      case 'chat':
        if (down) this.openChat();
        return;
      case 'scores':
        if (down) {
          this.hud.showScores(!this.hud.scoresOpen);
          this.hud.renderScores(this.players, this.you);
        }
        return;
      case 'spectate':
        if (down) this.toggleSpectate();
        return;
      case 'map':
        if (down) this.hud.mapMode++;
        return;
      case 'mute':
        if (!down) return;
        this.prefs.mute = !this.prefs.mute;
        this.prefs.save();
        this.audio.volume();
        this.hud.message(this.prefs.mute ? 'Sound off.' : 'Sound on.');
        return;
    }
  }

  toggleSpectate() {
    const wish = !this.isSpectatorWish();
    this.spectateWish = wish;
    this.spectateRound = this.game?.round;
    this.net.send({ t: 'spectate', on: wish });
    this.hud.message(wish ? 'You watch from the next round on.' : 'You play again from the next round on.');
    this.updateMenu();
  }

  isSpectatorWish() {
    // the wish shows in the list from the next round on; remember what we asked for
    if (this.spectateWish !== undefined && this.spectateRound === this.game?.round) return this.spectateWish;
    return this.isSpectator();
  }

  chatEl() {
    return document.getElementById('chat');
  }

  openChat() {
    const chat = this.chatEl();
    chat.hidden = false;
    this.hud.chatOpen = true;
    this.hud.renderConsole();
    const input = document.getElementById('chat-input');
    input.value = '';
    input.focus();
    this.net.send({ t: 'typing', on: true });
    this.game?.brake(false);
  }

  closeChat(tell = true) {
    const chat = this.chatEl();
    chat.hidden = true;
    this.hud.chatOpen = false;
    this.hud.renderConsole();
    document.getElementById('chat-input').blur();
    if (tell) this.net.send({ t: 'typing', on: false });
  }

  // -------------------------------------------------------------------
  // The in-game menu

  setupMenu() {
    const menu = document.getElementById('menu');
    const help = {
      resume: 'Back to the game.',
      camera: 'The view: behind the cycle (custom), from the cycle (internal), and more. The V key switches it too.',
      spectate: 'Watch instead of playing, from the next round on (the B key).',
      invite: 'Copy the link to this server; whoever opens it joins you here.',
      settings: 'Keys, sound and display.',
      admin: 'Your server: its rules, and kicking or banning players.',
      about: 'Who made the game, its license, and where its source code is.',
      leave: 'Back to the list of servers.',
    };
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-menu]');
      if (!b) return;
      this.audio.unlock();
      switch (b.dataset.menu) {
        case 'resume':
          this.closeMenu();
          break;
        case 'camera':
          this.cycleCamera(1);
          break;
        case 'spectate':
          this.toggleSpectate();
          break;
        case 'invite':
          this.invite();
          break;
        case 'settings':
          this.openSettings();
          break;
        case 'admin':
          this.openAdmin();
          break;
        case 'about':
          document.getElementById('about').showModal();
          break;
        case 'leave':
          this.leave();
          break;
      }
    });
    menu.addEventListener('keydown', (e) => {
      navigate(menu, e, {
        onLeftRight: (el, d) => {
          if (el.dataset.menu === 'camera') this.cycleCamera(d);
          else if (el.dataset.menu === 'spectate') this.toggleSpectate();
          else return false;
          return true;
        },
      });
    });
    // one highlight, like the original: the mouse moves it too
    menu.addEventListener('mouseover', (e) => {
      const b = e.target.closest('button[data-menu]');
      if (b && document.activeElement !== b) b.focus({ preventScroll: true });
    });
    menu.addEventListener('focusin', (e) => {
      const b = e.target.closest('button[data-menu]');
      if (b) document.getElementById('menu-help').textContent = help[b.dataset.menu] ?? '';
    });
  }

  cycleCamera(d) {
    const i = MODES.indexOf(this.camera.mode);
    const next = MODES[(i + d + MODES.length) % MODES.length];
    this.camera.setMode(next);
    this.prefs.camera = next;
    this.prefs.save();
    this.updateMenu();
  }

  toggleMenu() {
    const menu = document.getElementById('menu');
    if (menu.hidden) {
      menu.hidden = false;
      this.game?.brake(false);
      this.updateMenu();
      menu.querySelector('button').focus();
    } else {
      this.closeMenu();
    }
  }

  closeMenu() {
    document.getElementById('menu').hidden = true;
    document.activeElement?.blur?.();
  }

  updateMenu() {
    document.getElementById('menu-camera').textContent = MODE_NAMES[this.camera.mode].replace(' camera', '');
    document.getElementById('menu-spectate').textContent = this.isSpectatorWish() ? 'Play again' : 'Spectate';
  }

  invite() {
    const url = `${location.origin}${location.pathname}#/${this.room}`;
    const done = () => this.hud.message(`0x7fff7fThe invitation link is on your clipboard: ${url}`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => this.hud.message(`Send your friends this link: ${url}`));
    } else {
      this.hud.message(`Send your friends this link: ${url}`);
    }
    this.closeMenu();
  }

  // -------------------------------------------------------------------
  // Settings: keys, sound, display

  setupSettings() {
    const dialog = document.getElementById('settings');
    const p = this.prefs;
    const cam = document.getElementById('set-camera');
    for (const m of MODES) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = MODE_NAMES[m];
      cam.append(o);
    }
    const bind = (id, key, apply) => {
      const el = document.getElementById(id);
      const set = () => {
        if (el.type === 'checkbox') el.checked = p[key] !== false;
        else el.value = String(p[key]);
      };
      set();
      el.addEventListener('input', () => {
        p[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' || key === 'quality' ? Number(el.value) : el.value;
        p.save();
        apply?.();
      });
      return set;
    };
    this.settingsRefresh = [
      bind('set-volume', 'volume', () => this.audio.volume()),
      bind('set-music', 'music', () => { this.audio.volume(); if (p.music && !this.audio.music) { const k = this.audio.track; this.audio.track = null; this.audio.playMusic(k); } }),
      bind('set-mute', 'mute', () => this.audio.volume()),
      bind('set-quality', 'quality', () => { if (this.renderer) this.renderer.scale = p.quality; }),
      bind('set-camera', 'camera', () => this.camera.setMode(p.camera)),
      bind('set-names', 'names'),
      bind('set-map', 'map'),
      bind('set-clock', 'clock'),
    ];
    document.getElementById('set-mute').checked = !!p.mute;
    document.getElementById('set-mute').addEventListener('input', (e) => { p.mute = e.target.checked; p.save(); this.audio.volume(); });
    document.getElementById('keys-reset').addEventListener('click', () => {
      p.keys = structuredClone(DEFAULT_KEYS);
      p.save();
      this.renderBindings();
    });
    dialog.addEventListener('close', () => this.stopListening?.());
  }

  openSettings() {
    for (const f of this.settingsRefresh) f();
    document.getElementById('set-mute').checked = !!this.prefs.mute;
    this.renderBindings();
    document.getElementById('settings').showModal();
  }

  renderBindings() {
    const table = document.getElementById('bindings');
    const focused = table.contains(document.activeElement) ? document.activeElement.dataset : null;
    const at = focused ? { row: focused.row, col: focused.col } : null;
    table.replaceChildren();
    Object.entries(ACTIONS).forEach(([action, label], row) => {
      const tr = table.insertRow();
      tr.insertCell().textContent = label;
      const keys = this.prefs.keys[action] ?? [];
      for (let i = 0; i < 3; i++) {
        const td = tr.insertCell();
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = keyName(keys[i]) || '—';
        b.dataset.row = row;
        b.dataset.col = i;
        b.addEventListener('click', () => this.listen(action, i, b));
        td.append(b);
      }
    });
    // the keyboard stays where it was
    if (at) table.querySelector(`[data-row="${at.row}"][data-col="${at.col}"]`)?.focus();
  }

  listen(action, index, button) {
    this.stopListening?.();
    button.classList.add('listening');
    button.textContent = 'press a key';
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stopListening = null;
      window.removeEventListener('keydown', handler, true);
      this.binding = null;
      const keys = [...(this.prefs.keys[action] ?? [])];
      if (e.code === 'Escape') {
        // keep what was there
      } else if (e.code === 'Backspace' || e.code === 'Delete') {
        keys.splice(index, 1);
      } else {
        // a key does one thing only
        for (const k of Object.keys(this.prefs.keys)) this.prefs.keys[k] = this.prefs.keys[k].filter((c) => c !== e.code);
        keys.splice(index, 1, e.code);
        const again = [...(this.prefs.keys[action] ?? [])].filter((c) => c !== e.code);
        again.splice(index, 0, e.code);
        this.prefs.keys[action] = [...new Set(again)].slice(0, 3);
        this.prefs.save();
        this.renderBindings();
        return;
      }
      this.prefs.keys[action] = keys.filter(Boolean).slice(0, 3);
      this.prefs.save();
      this.renderBindings();
    };
    this.binding = action;
    window.addEventListener('keydown', handler, true);
    this.stopListening = () => {
      this.stopListening = null;
      window.removeEventListener('keydown', handler, true);
      this.binding = null;
      this.renderBindings();
    };
  }

  // -------------------------------------------------------------------
  // Administration, for the owner of the server

  setupAdmin() {
    const dialog = document.getElementById('admin');
    dialog.addEventListener('close', () => {
      this.adminOpen = false;
      if (dialog.returnValue === 'ok') {
        this.net.send({ t: 'admin', cmd: 'settings', settings: readRuleFields(document.getElementById('admin-fields')) });
      }
    });
    document.getElementById('admin-restart').addEventListener('click', () => {
      this.net.send({ t: 'admin', cmd: 'restart' });
      dialog.close('cancel');
      this.closeMenu();
    });
    const ban = document.getElementById('ban');
    ban.addEventListener('close', () => {
      if (ban.returnValue === 'ok' && this.banTarget) {
        this.net.send({
          t: 'admin', cmd: 'ban', id: this.banTarget,
          minutes: Number(document.getElementById('ban-minutes').value),
          reason: document.getElementById('ban-reason').value,
        });
      }
      this.banTarget = null;
    });
  }

  openAdmin() {
    if (!this.admin) return;
    buildRuleFields(document.getElementById('admin-fields'), this.settings);
    this.renderAdminPlayers();
    this.net.send({ t: 'admin', cmd: 'bans' });
    this.adminOpen = true;
    const dialog = document.getElementById('admin');
    dialog.returnValue = '';
    dialog.showModal();
  }

  renderAdminPlayers() {
    const table = document.getElementById('admin-players');
    table.replaceChildren();
    for (const p of this.players) {
      const tr = table.insertRow();
      const name = tr.insertCell();
      name.textContent = strip(p.name);
      paint(name, hex15(p.r, p.g, p.b));
      tr.insertCell().textContent = p.bot ? 'AI' : p.spectator ? 'watching' : `${p.ping} ms`;
      const actions = tr.insertCell();
      if (p.id === this.you || p.bot) continue;
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.textContent = 'Kick';
      kick.addEventListener('click', () => this.net.send({ t: 'admin', cmd: 'kick', id: p.id }));
      const ban = document.createElement('button');
      ban.type = 'button';
      ban.textContent = 'Ban';
      ban.className = 'danger';
      ban.addEventListener('click', () => {
        this.banTarget = p.id;
        document.getElementById('ban-title').textContent = `Ban ${strip(p.name)}`;
        document.getElementById('ban-reason').value = '';
        const dialog = document.getElementById('ban');
        dialog.returnValue = '';
        dialog.showModal();
      });
      const kill = document.createElement('button');
      kill.type = 'button';
      kill.textContent = 'Smite';
      kill.title = 'Destroy their cycle this round';
      kill.addEventListener('click', () => this.net.send({ t: 'admin', cmd: 'kill', id: p.id }));
      actions.append(kill, ' ', kick, ' ', ban);
    }
  }

  renderBans(bans) {
    const el = document.getElementById('admin-bans');
    if (!bans.length) {
      el.textContent = 'Nobody is banned.';
      return;
    }
    el.replaceChildren(...bans.map((b) => {
      const row = document.createElement('div');
      row.textContent = `${b.name}, ${b.minutes < 0 ? 'while the server runs' : `${b.minutes} more minutes`} `;
      const un = document.createElement('button');
      un.type = 'button';
      un.className = 'small-button';
      un.textContent = 'Unban';
      un.addEventListener('click', () => this.net.send({ t: 'admin', cmd: 'unban', index: b.index }));
      row.append(un);
      return row;
    }));
  }
}

window.app = new App();
