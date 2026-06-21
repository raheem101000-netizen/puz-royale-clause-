import { Room, Client, matchMaker } from "@colyseus/core";

interface PlayerData {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  master: boolean;
}

export class PuzGameLobby extends Room {
  maxClients = 16;

  private lobbyPlayers: Record<string, PlayerData> = {};
  private lobbyName: string = '';
  private lobbyLocked: boolean = false;
  private lobbyPassword: string | null = null;

  async onCreate(options: any) {
    this.lobbyName = options.name || 'Room';
    this.lobbyPassword = options.password || null;
    this.lobbyLocked = !!this.lobbyPassword;

    // Private rooms stay listed (open: true) so they appear in the lobby with a lock
    // badge. We only set open: false when the game launches to remove the entry.
    await this.setMetadata({ name: this.lobbyName, open: true, locked: this.lobbyLocked, players: 0 });

    this.onMessage("room:getState", (client: Client) => {
      const p = this.lobbyPlayers[client.sessionId];
      if (!p) return;
      client.send('room:join', { room: this.serializeRoom(), player: this.serializePlayer(p) });
    });

    this.onMessage("room:ready", (client: Client) => {
      const p = this.lobbyPlayers[client.sessionId];
      if (!p) return;
      p.ready = true;
      this.broadcast('room:player:ready', { player: this.serializePlayer(p) });
      this.broadcast('room:state', this.serializeRoom());
    });

    this.onMessage("room:launch", async (client: Client, data: any) => {
      const p = this.lobbyPlayers[client.sessionId];
      if (!p || !p.master) return;
      const isDev = data?.dev === true;
      const players = Object.values(this.lobbyPlayers);
      if (!isDev && players.filter(pp => pp.ready).length < 1) {
        client.send('room:error', { message: 'Need at least 1 ready player' });
        return;
      }
      try {
        const mapSize = Math.min(16, Math.max(2, parseInt(data?.mapSize) || 8));
        const gameRoom = await matchMaker.createRoom("puz_room", { mapSize });
        // Remove from lobby listing immediately (belt+suspenders: both setPrivate
        // and metadata open:false, since setPrivate alone may not update existing
        // LobbyRoom connections in all Colyseus 0.17 builds).
        await this.setPrivate(true);
        await this.setMetadata({ name: this.lobbyName, open: false, locked: this.lobbyLocked, players: Object.keys(this.lobbyPlayers).length });
        this.broadcast('room:launch:start', {});
        setTimeout(() => {
          this.broadcast('room:game:start', { roomId: gameRoom.roomId });
          // Force-disconnect remaining clients after a brief delivery window.
          // WebSocket sends queued messages (including room:game:start) before
          // the close frame, so clients will receive the roomId before disconnect.
          // This guarantees autoDispose fires even if a client never navigates away.
          setTimeout(() => {
            this.clients.forEach(c => c.leave(1000));
          }, 300);
        }, 3000);
      } catch (e) {
        client.send('room:error', { message: 'Failed to start game' });
      }
    });

    this.onMessage("room:talk", (client: Client, data: any) => {
      const p = this.lobbyPlayers[client.sessionId];
      this.broadcast('room:talk', {
        player: p?.name || 'Unknown',
        content: String(data?.content || '').slice(0, 200),
      });
    });

    this.onMessage("room:leave", (client: Client) => {
      client.leave();
    });
  }

  async onJoin(client: Client, options: any) {
    if (this.lobbyPassword && options.password !== this.lobbyPassword) {
      throw new Error("Wrong password");
    }

    const isMaster = Object.keys(this.lobbyPlayers).length === 0;
    const pd: PlayerData = {
      id: client.sessionId,
      name: options.playerName || 'Player',
      color: options.color || '#4CFF6C',
      ready: false,
      master: isMaster,
    };
    this.lobbyPlayers[client.sessionId] = pd;

    await this.setMetadata({ name: this.lobbyName, open: true, locked: this.lobbyLocked, players: Object.keys(this.lobbyPlayers).length });

    if (!isMaster) {
      this.broadcast('room:player:join', { player: this.serializePlayer(pd) }, { except: client });
      this.broadcast('room:state', this.serializeRoom());
    }
  }

  async onLeave(client: Client, _code?: number) {
    const p = this.lobbyPlayers[client.sessionId];
    if (!p) return;
    delete this.lobbyPlayers[client.sessionId];

    // Early-return before setMetadata when room is now empty — avoids a 0-player
    // metadata update that would show as a ghost entry before autoDispose fires.
    if (Object.keys(this.lobbyPlayers).length === 0) return;

    await this.setMetadata({ name: this.lobbyName, open: true, locked: this.lobbyLocked, players: Object.keys(this.lobbyPlayers).length });

    this.broadcast('room:player:leave', { player: client.sessionId });

    if (p.master) {
      const newMasterId = Object.keys(this.lobbyPlayers)[0];
      this.lobbyPlayers[newMasterId].master = true;
      this.broadcast('room:master', { master: newMasterId });
    }
    this.broadcast('room:state', this.serializeRoom());
  }

  private serializePlayer(p: PlayerData) {
    return { id: p.id, name: p.name, color: p.color, ready: p.ready, master: p.master };
  }

  private serializeRoom() {
    const players = Object.values(this.lobbyPlayers);
    return {
      id: this.roomId,
      name: this.lobbyName,
      locked: this.lobbyLocked,
      master: players.find(p => p.master)?.id || '',
      players: players.map(this.serializePlayer.bind(this)),
    };
  }
}
