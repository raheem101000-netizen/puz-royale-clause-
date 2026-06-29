import { Room, Client } from "@colyseus/core";

// ── Map configs verbatim from puz-maptest.html ────────────────────────────
const SIZES: Record<number, [number, number, number]> = {
  2:[600,400,28],   3:[700,500,28],   4:[800,500,30],
  5:[900,600,30],   6:[1100,700,32],  7:[1200,800,34],  8:[1300,800,34],
  9:[1400,900,36],  10:[1600,1000,38],11:[1700,1000,38],12:[1800,1100,40],
  13:[1800,1100,40],14:[1900,1200,42],15:[2000,1200,42],16:[2000,1300,44]
};

interface ZonePhase { wait: number; shrinkTo: number; shrinkTime: number; }

function phasesFor(p: number): number {
  if(p<=4) return 3; if(p<=7) return 4; if(p<=10) return 5;
  if(p<=14) return 6; if(p<=17) return 7; return 8;
}

function mkZones(phases: number, diag: number): ZonePhase[] {
  const z: ZonePhase[] = [];
  const startR = diag/2 + 100;
  for(let i=0; i<phases; i++){
    const frac = 1 - (i+1)/(phases+0.4);
    const wait = Math.round(90 - i*9);
    const shrinkTime = Math.round(40 - i*3);
    z.push({wait:Math.max(18,wait), shrinkTo:Math.round(startR*Math.max(0.06,frac)), shrinkTime:Math.max(14,shrinkTime)});
  }
  return z;
}

interface Wall { x: number; y: number; w: number; h: number; }
interface Input { up: boolean; down: boolean; left: boolean; right: boolean; angle: number; shooting: boolean; reload: boolean; }
interface Player {
  id: string; name: string; color: string; pid?: string;
  x: number; y: number; hp: number; maxHp: number;
  alive: boolean; connected: boolean; angle: number; speed: number; r: number;
  ammo: number; maxAmmo: number; reloading: boolean; reloadTimer: number;
  shootCooldown: number; input: Input; lastSeq: number;
}
interface Bullet {
  x: number; y: number; vx: number; vy: number;
  ownerId: string; color: string; r: number; life: number;
}

const PLAYER_R = 10;
const BULLET_R = 4;
const BULLET_SPEED = 9;
const PLAYER_SPEED = 5.2;
const MAX_HP = 100;

function generateWalls(WW: number, WH: number, playerCount: number): Wall[] {
  const w: Wall[] = [];
  const blockW = Math.max(40, WW*0.04);
  const blockH = Math.max(30, WH*0.05);
  const positions: Array<{x:number;y:number;lx?:boolean;tall?:boolean}> = [
    {x:0.12,y:0.12},{x:0.30,y:0.10},{x:0.50,y:0.11},{x:0.70,y:0.10},{x:0.88,y:0.12},
    {x:0.20,y:0.28},{x:0.42,y:0.25},{x:0.58,y:0.25},{x:0.80,y:0.28},
    {x:0.35,y:0.45},{x:0.50,y:0.42},{x:0.65,y:0.45},{x:0.50,y:0.55},
    {x:0.20,y:0.65},{x:0.42,y:0.68},{x:0.58,y:0.68},{x:0.80,y:0.65},
    {x:0.12,y:0.82},{x:0.30,y:0.84},{x:0.50,y:0.83},{x:0.70,y:0.84},{x:0.88,y:0.82},
    {x:0.25,y:0.38,lx:true},{x:0.75,y:0.38,lx:true},
    {x:0.25,y:0.58,lx:true},{x:0.75,y:0.58,lx:true},
    {x:0.38,y:0.35,tall:true},{x:0.62,y:0.35,tall:true},
    {x:0.38,y:0.58,tall:true},{x:0.62,y:0.58,tall:true},
  ];
  const density = Math.min(1, 0.55 + playerCount/40);
  const count = Math.floor(positions.length * density);
  positions.slice(0, count).forEach(p => {
    const x = Math.round(p.x * WW);
    const y = Math.round(p.y * WH);
    if(p.tall){
      w.push({x,y,w:Math.max(15,WW*0.008),h:Math.max(80,WH*0.12)});
    } else if(p.lx){
      w.push({x,y,w:blockW,h:Math.max(12,WH*0.015)});
      w.push({x,y,w:Math.max(12,WW*0.008),h:blockH});
    } else {
      const bw = blockW * (0.7 + Math.random()*0.6);
      const bh = blockH * (0.7 + Math.random()*0.6);
      w.push({x:x-bw/2,y:y-bh/2,w:bw,h:bh});
    }
  });
  return w;
}

function isWall(x: number, y: number, r: number, walls: Wall[]): boolean {
  return walls.some(w => x+r>w.x && x-r<w.x+w.w && y+r>w.y && y-r<w.y+w.h);
}

function isInZone(x: number, y: number, zoneX: number, zoneY: number, zoneR: number): boolean {
  return Math.hypot(x-zoneX, y-zoneY) <= zoneR;
}

function spawnPos(WW: number, WH: number, zoneX: number, zoneY: number, zoneR: number, walls: Wall[]): {x:number;y:number} {
  let x = 0, y = 0, tries = 0;
  do {
    x = 100 + Math.random()*(WW-200);
    y = 100 + Math.random()*(WH-200);
    tries++;
  } while((isWall(x,y,12,walls) || !isInZone(x,y,zoneX,zoneY,zoneR)) && tries<200);
  return {x, y};
}

function moveEntity(e: Player, dx: number, dy: number, WW: number, WH: number, walls: Wall[]) {
  const nx = e.x + dx * e.speed;
  const ny = e.y + dy * e.speed;
  if(nx-e.r>=0 && nx+e.r<=WW && !isWall(nx, e.y, e.r-1, walls)) e.x = nx;
  if(ny-e.r>=0 && ny+e.r<=WH && !isWall(e.x, ny, e.r-1, walls)) e.y = ny;
}

export class PuzRoom extends Room {
  maxClients = 16;

  private WW = 1300; private WH = 800; private TILE = 34;
  private walls: Wall[] = [];
  private players: Record<string, Player> = {};
  private bullets: Bullet[] = [];
  private aliveCount = 0;
  private placement = 0;
  private active = false;
  private startedPlayerCount = 0;
  private loop: ReturnType<typeof setInterval> | null = null;
  private zoneInterval: ReturnType<typeof setInterval> | null = null;

  // Zone state (circular, verbatim from test file)
  private zoneX = 0; private zoneY = 0; private zoneR = 0;
  private targetZoneR = 0;
  private zonePhases: ZonePhase[] = [];
  private zonePhaseIdx = 0;
  private zoneTimer = 0;
  private shrinking = false;

  async onCreate(options: any) {
    const playerCount = Math.min(16, Math.max(2, parseInt(options?.mapSize) || 8));
    const cfg = SIZES[playerCount] || SIZES[8];
    this.WW = cfg[0]; this.WH = cfg[1]; this.TILE = cfg[2];
    this.maxClients = playerCount;

    const diag = Math.sqrt(this.WW*this.WW + this.WH*this.WH);
    this.zoneX = this.WW/2; this.zoneY = this.WH/2;
    this.zoneR = diag/2 + 100;
    this.targetZoneR = this.zoneR;
    this.zonePhases = mkZones(phasesFor(playerCount), diag);
    this.walls = generateWalls(this.WW, this.WH, playerCount);

    this.onMessage("puz:join", (client: Client, data: {name?:string;color?:string;pid?:string}) => {
      if (this.players[client.sessionId]) return;

      const name = (data.name || 'Player').slice(0, 24);
      const pid = data.pid || '';

      // Reconnect: match by persistent player ID (pid) first, then fall back to name.
      const dupId = pid
        ? Object.keys(this.players).find(id => this.players[id].pid === pid)
        : Object.keys(this.players).find(id => this.players[id].name === name);
      if (dupId) {
        const existing = this.players[dupId];
        existing.id = client.sessionId;
        this.players[client.sessionId] = existing;
        delete this.players[dupId];
        if (this.active) {
          client.send('puz:started', {
            walls: this.walls, WW: this.WW, WH: this.WH, TILE: this.TILE,
            zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR
          });
        }
        const allPlayers = Object.values(this.players);
        this.broadcast('puz:lobby', {
          players: allPlayers.map(p => ({id:p.id,name:p.name,color:p.color})),
          hostId: allPlayers[0]?.id || client.sessionId
        });
        return;
      }

      const pos = spawnPos(this.WW, this.WH, this.zoneX, this.zoneY, this.zoneR, this.walls);
      this.players[client.sessionId] = {
        id: client.sessionId,
        name,
        color: data.color || '#4CFF6C',
        pid,
        x: pos.x, y: pos.y,
        hp: MAX_HP, maxHp: MAX_HP,
        alive: true, connected: true, angle: 0, lastSeq: 0,
        speed: PLAYER_SPEED, r: PLAYER_R,
        ammo: 30, maxAmmo: 30,
        reloading: false, reloadTimer: 0,
        shootCooldown: 0,
        input: {up:false,down:false,left:false,right:false,angle:0,shooting:false,reload:false}
      };
      this.aliveCount++;

      if (this.active) {
        client.send('puz:started', {
          walls: this.walls, WW: this.WW, WH: this.WH, TILE: this.TILE,
          zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR
        });
      }

      const allPlayers = Object.values(this.players);
      const hostId = allPlayers[0]?.id || client.sessionId;
      this.broadcast('puz:lobby', {
        players: allPlayers.map(p => ({id:p.id,name:p.name,color:p.color})),
        hostId
      });
    });

    this.onMessage("puz:start", (_client: Client) => {
      if (this.active) return;
      this.startGame();
    });

    this.onMessage("puz:input", (client: Client, data: {input:Input; seq?: number}) => {
      const p = this.players[client.sessionId];
      if (!p || !p.alive) return;
      if (data.input) p.input = data.input;
      if (typeof data.seq === 'number') p.lastSeq = data.seq;
    });
  }

  async onLeave(client: Client, code?: number) {
    const p = this.players[client.sessionId];
    if (!p) return;

    // code 1000 = normal closure (client called room.leave()) — remove immediately.
    if (code === 1000) {
      this.removePlayer(client.sessionId);
      return;
    }

    // Unclean disconnect: may be a brief blip (WiFi stutter, tab blur, free-host
    // latency spike). Hold the player slot for 20 s before treating them as gone.
    // If they reconnect (Colyseus token or name-based dedup in puz:join) within
    // the window, the game continues without interruption.
    p.connected = false;
    try {
      await this.allowReconnection(client, 20);
      p.connected = true;
    } catch {
      // Grace expired — truly gone.
      this.removePlayer(client.sessionId);
    }
  }

  private removePlayer(sessionId: string) {
    const p = this.players[sessionId];
    if (!p) return;
    if (p.alive) {
      p.alive = false;
      this.aliveCount = Math.max(0, this.aliveCount - 1);
    }
    delete this.players[sessionId];
    this.checkWinCondition();
  }

  private startGame() {
    this.startedPlayerCount = this.aliveCount;
    this.active = true;
    this.broadcast('puz:started', {
      walls: this.walls, WW: this.WW, WH: this.WH, TILE: this.TILE,
      zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR
    });
    this.startZone();
    this.loop = setInterval(() => this.puzTick(), 16);
  }

  private startZone() {
    this.zonePhaseIdx = 0; this.shrinking = false;
    this.zoneTimer = this.zonePhases[0]?.wait ?? 90;
    this.broadcast('puz:zone', {
      zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR,
      timer: this.zoneTimer, shrinking: false
    });

    this.zoneInterval = setInterval(() => {
      this.zoneTimer--;
      if (!this.shrinking) {
        if (this.zoneTimer <= 0 && this.zonePhaseIdx < this.zonePhases.length) {
          const phase = this.zonePhases[this.zonePhaseIdx];
          this.targetZoneR = phase.shrinkTo;
          this.shrinking = true;
          this.zoneTimer = phase.shrinkTime;
          this.zonePhaseIdx++;
        }
      } else {
        const totalShrink = this.zoneR - this.targetZoneR;
        const shrinkPerSecond = totalShrink / Math.max(1, this.zoneTimer);
        this.zoneR = Math.max(this.targetZoneR, this.zoneR - shrinkPerSecond);
        if (this.zoneTimer <= 0 || this.zoneR <= this.targetZoneR) {
          this.zoneR = this.targetZoneR;
          this.shrinking = false;
          this.zoneTimer = this.zonePhaseIdx < this.zonePhases.length
            ? this.zonePhases[this.zonePhaseIdx].wait
            : 999;
        }
      }
      this.broadcast('puz:zone', {
        zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR,
        timer: Math.max(0, this.zoneTimer), shrinking: this.shrinking
      });
    }, 1000);
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
    const spread = (Math.random() - 0.5) * 0.08;
    this.bullets.push({
      x: shooter.x, y: shooter.y,
      vx: (dx/dist)*BULLET_SPEED + Math.cos(spread),
      vy: (dy/dist)*BULLET_SPEED + Math.sin(spread),
      ownerId: shooter.id, color: shooter.color, r: BULLET_R, life: 120
    });
    shooter.ammo--;
    shooter.shootCooldown = 14;
  }

  private kill(entity: Player) {
    if (!entity.alive) return;
    entity.alive = false;
    this.aliveCount = Math.max(0, this.aliveCount - 1);
    this.placement++;
    this.broadcast('puz:kill', {name:entity.name, color:entity.color, place:this.placement});
    this.checkWinCondition();
  }

  private checkWinCondition() {
    if (!this.active) return;
    if (this.startedPlayerCount < 2) return;
    const alive = Object.values(this.players).filter(p => p.alive);
    if (alive.length <= 1) {
      this.broadcast('puz:end', {
        winnerId: alive[0]?.id || null,
        winnerName: alive[0]?.name || null,
        total: Object.keys(this.players).length + this.placement
      });
      // Notify winner to submit prize claim
      if (alive[0]) {
        const winnerClient = this.clients.find(c => c.sessionId === alive[0].id);
        if (winnerClient) {
          winnerClient.send('payout', { prize_amount: '$8', game: 'Puz Royale Multiplayer' });
        }
      }
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
      moveEntity(p, dx, dy, this.WW, this.WH, this.walls);
      p.angle = p.input.angle || 0;

      if (p.input.shooting && !p.reloading && p.shootCooldown <= 0) {
        this.shoot(p, p.x + Math.cos(p.angle)*200, p.y + Math.sin(p.angle)*200);
      }
      if ((p.input.reload || p.ammo === 0) && !p.reloading && p.ammo < p.maxAmmo) {
        p.reloading = true; p.reloadTimer = 90;
      }

      if (!isInZone(p.x, p.y, this.zoneX, this.zoneY, this.zoneR)) {
        p.hp -= 0.3;
        if (p.hp <= 0) this.kill(p);
      }
    }

    this.bullets = this.bullets.filter(b => {
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life<=0 || b.x<0 || b.x>this.WW || b.y<0 || b.y>this.WH) return false;
      if (isWall(b.x, b.y, 2, this.walls)) return false;
      for (const t of players) {
        if (!t.alive || t.id === b.ownerId) continue;
        if (Math.hypot(b.x-t.x, b.y-t.y) < t.r+b.r) {
          t.hp -= 22;
          if (t.hp <= 0) this.kill(t);
          return false;
        }
      }
      return true;
    });

    this.broadcast('puz:state', {
      players: players.map(p => ({
        id:p.id, x:p.x, y:p.y,
        hp:p.hp, maxHp:p.maxHp,
        angle:p.angle, alive:p.alive,
        color:p.color, name:p.name,
        ammo:p.ammo, maxAmmo:p.maxAmmo,
        reloading:p.reloading, r:p.r, lastSeq:p.lastSeq
      })),
      bullets: this.bullets.map(b => ({x:b.x, y:b.y, vx:b.vx, vy:b.vy, color:b.color})),
      zoneX: this.zoneX, zoneY: this.zoneY, zoneR: this.zoneR,
      aliveCount: this.aliveCount
    });
  }

  onDispose() { this.stopGame(); }
}
