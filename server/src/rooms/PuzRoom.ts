import { Room, Client } from "@colyseus/core";

const W = 720, H = 480;
const TILE = 30;
const PLAYER_R = 8;
const BULLET_R = 3;
const BULLET_SPEED = 7;
const PLAYER_SPEED = 2.4;
const MAX_HP = 100;

interface Wall { x: number; y: number; w: number; h: number; }
interface Input { up: boolean; down: boolean; left: boolean; right: boolean; angle: number; shooting: boolean; }
interface Player {
  id: string; name: string; color: string;
  x: number; y: number; hp: number; maxHp: number;
  alive: boolean; angle: number; speed: number; r: number;
  ammo: number; maxAmmo: number; reloading: boolean; reloadTimer: number;
  shootCooldown: number; input: Input;
}
interface Bullet {
  x: number; y: number; vx: number; vy: number;
  ownerId: string; color: string; r: number; life: number;
}

function generateWalls(): Wall[] {
  const w: Wall[] = [];
  const patterns = [
    {x:4,y:3,w:3,h:1},{x:12,y:3,w:3,h:1},{x:20,y:3,w:3,h:1},
    {x:4,y:18,w:3,h:1},{x:12,y:18,w:3,h:1},{x:20,y:18,w:3,h:1},
    {x:2,y:8,w:1,h:4},{x:8,y:8,w:1,h:4},{x:15,y:8,w:1,h:4},{x:22,y:8,w:1,h:4},
    {x:2,y:13,w:1,h:4},{x:8,y:13,w:1,h:4},{x:15,y:13,w:1,h:4},{x:22,y:13,w:1,h:4},
    {x:5,y:10,w:4,h:2},{x:13,y:10,w:4,h:2},{x:19,y:6,w:2,h:2},{x:10,y:6,w:2,h:2},
    {x:10,y:15,w:2,h:2},{x:19,y:15,w:2,h:2},{x:6,y:5,w:2,h:1},{x:17,y:5,w:2,h:1},
  ];
  patterns.forEach(p => {
    for (let dx = 0; dx < p.w; dx++)
      for (let dy = 0; dy < p.h; dy++)
        w.push({ x: (p.x + dx) * TILE, y: (p.y + dy) * TILE, w: TILE, h: TILE });
  });
  return w;
}

function isWall(x: number, y: number, r: number, walls: Wall[]): boolean {
  return walls.some(w => x + r > w.x && x - r < w.x + w.w && y + r > w.y && y - r < w.y + w.h);
}

function isInZone(x: number, y: number, zoneSize: number): boolean {
  return x >= zoneSize && x <= W - zoneSize && y >= zoneSize && y <= H - zoneSize;
}

function spawnPos(walls: Wall[]): { x: number; y: number } {
  let x = 0, y = 0, tries = 0;
  do {
    x = 40 + Math.random() * (W - 80);
    y = 40 + Math.random() * (H - 80);
    tries++;
  } while (isWall(x, y, 12, walls) && tries < 100);
  return { x, y };
}

function moveEntity(e: Player, dx: number, dy: number, walls: Wall[]) {
  const nx = e.x + dx * e.speed;
  const ny = e.y + dy * e.speed;
  if (nx - e.r >= 0 && nx + e.r <= W && !isWall(nx, e.y, e.r - 1, walls)) e.x = nx;
  if (ny - e.r >= 0 && ny + e.r <= H && !isWall(e.x, ny, e.r - 1, walls)) e.y = ny;
}

export class PuzRoom extends Room {
  maxClients = 8;

  private walls: Wall[] = [];
  private players: Record<string, Player> = {};
  private bullets: Bullet[] = [];
  private zoneSize = 0;
  private zoneTimer = 30;
  private aliveCount = 0;
  private placement = 0;
  private active = false;
  private loop: ReturnType<typeof setInterval> | null = null;
  private zoneInterval: ReturnType<typeof setInterval> | null = null;

  onCreate() {
    this.walls = generateWalls();

    this.onMessage("puz:join", (client: Client, data: { name?: string; color?: string }) => {
      if (this.players[client.sessionId]) return;
      const pos = spawnPos(this.walls);
      this.players[client.sessionId] = {
        id: client.sessionId,
        name: data.name || 'Player',
        color: data.color || '#4CFF6C',
        x: pos.x, y: pos.y,
        hp: MAX_HP, maxHp: MAX_HP,
        alive: true, angle: 0,
        speed: PLAYER_SPEED, r: PLAYER_R,
        ammo: 30, maxAmmo: 30,
        reloading: false, reloadTimer: 0,
        shootCooldown: 0,
        input: { up: false, down: false, left: false, right: false, angle: 0, shooting: false }
      };
      this.aliveCount++;

      const allPlayers = Object.values(this.players);
      const hostId = allPlayers[0]?.id || client.sessionId;
      this.broadcast('puz:lobby', {
        players: allPlayers.map(p => ({ id: p.id, name: p.name, color: p.color })),
        hostId
      });
    });

    this.onMessage("puz:start", (_client: Client) => {
      if (this.active) return;
      this.startGame();
    });

    this.onMessage("puz:input", (client: Client, data: { input: Input }) => {
      const p = this.players[client.sessionId];
      if (!p || !p.alive) return;
      if (data.input) p.input = data.input;
    });
  }

  onLeave(client: Client) {
    const p = this.players[client.sessionId];
    if (p && p.alive) {
      p.alive = false;
      this.aliveCount = Math.max(0, this.aliveCount - 1);
      delete this.players[client.sessionId];
      this.checkWinCondition();
    }
  }

  private startGame() {
    this.active = true;
    this.broadcast('puz:started', { walls: this.walls });

    this.zoneInterval = setInterval(() => {
      this.zoneTimer--;
      if (this.zoneTimer <= 0) { this.zoneSize += 18; this.zoneTimer = 12; }
      this.broadcast('puz:zone', { zoneSize: this.zoneSize, timer: Math.max(0, this.zoneTimer) });
    }, 1000);

    this.loop = setInterval(() => this.puzTick(), 16);
  }

  private stopGame() {
    this.active = false;
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
    if (this.zoneInterval) { clearInterval(this.zoneInterval); this.zoneInterval = null; }
  }

  private shoot(shooter: Player, tx: number, ty: number) {
    if (shooter.ammo <= 0) { shooter.reloading = true; shooter.reloadTimer = 90; return; }
    if (shooter.shootCooldown > 0) return;
    const dx = tx - shooter.x, dy = ty - shooter.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const spread = (Math.random() - 0.5) * 0.06;
    this.bullets.push({
      x: shooter.x, y: shooter.y,
      vx: (dx / dist) * BULLET_SPEED + Math.cos(spread),
      vy: (dy / dist) * BULLET_SPEED + Math.sin(spread),
      ownerId: shooter.id, color: shooter.color, r: BULLET_R, life: 80
    });
    shooter.ammo--;
    shooter.shootCooldown = 12;
  }

  private kill(entity: Player) {
    if (!entity.alive) return;
    entity.alive = false;
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    this.placement++;
    this.broadcast('puz:kill', { name: entity.name, color: entity.color, place: this.placement });
    this.checkWinCondition();
  }

  private checkWinCondition() {
    const alive = Object.values(this.players).filter(p => p.alive);
    if (alive.length === 1) {
      this.broadcast('puz:end', {
        winnerId: alive[0].id,
        winnerName: alive[0].name,
        total: Object.keys(this.players).length + this.placement
      });
      this.stopGame();
    } else if (alive.length === 0) {
      this.stopGame();
    }
  }

  private puzTick() {
    const players = Object.values(this.players);

    for (const p of players) {
      if (!p.alive) continue;
      if (p.reloading) {
        p.reloadTimer--;
        if (p.reloadTimer <= 0) { p.reloading = false; p.ammo = p.maxAmmo; }
        continue;
      }
      if (p.shootCooldown > 0) p.shootCooldown--;

      let dx = 0, dy = 0;
      if (p.input.up)    dy = -1;
      if (p.input.down)  dy =  1;
      if (p.input.left)  dx = -1;
      if (p.input.right) dx =  1;
      if (dx && dy) { dx *= 0.707; dy *= 0.707; }
      moveEntity(p, dx, dy, this.walls);
      p.angle = p.input.angle || 0;

      if (p.input.shooting && !p.reloading && p.shootCooldown <= 0) {
        this.shoot(p, p.x + Math.cos(p.angle) * 100, p.y + Math.sin(p.angle) * 100);
      }
      if (p.ammo === 0 && !p.reloading) { p.reloading = true; p.reloadTimer = 90; }

      if (!isInZone(p.x, p.y, this.zoneSize)) {
        p.hp -= 0.4;
        if (p.hp <= 0) this.kill(p);
      }
    }

    this.bullets = this.bullets.filter(b => {
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 || b.x < 0 || b.x > W || b.y < 0 || b.y > H) return false;
      if (isWall(b.x, b.y, 2, this.walls)) return false;
      for (const t of players) {
        if (!t.alive || t.id === b.ownerId) continue;
        if (Math.hypot(b.x - t.x, b.y - t.y) < t.r + b.r) {
          t.hp -= 25;
          if (t.hp <= 0) this.kill(t);
          return false;
        }
      }
      return true;
    });

    this.broadcast('puz:state', {
      players: players.map(p => ({
        id: p.id, x: p.x, y: p.y,
        hp: p.hp, maxHp: p.maxHp,
        angle: p.angle, alive: p.alive,
        color: p.color, name: p.name,
        ammo: p.ammo, maxAmmo: p.maxAmmo,
        reloading: p.reloading
      })),
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, color: b.color })),
      zoneSize: this.zoneSize,
      aliveCount: this.aliveCount
    });
  }

  onDispose() {
    this.stopGame();
  }
}
