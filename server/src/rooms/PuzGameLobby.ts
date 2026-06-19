import { Room, Client, matchMaker } from "@colyseus/core";

interface PlayerData {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  master: boolean;
}

export class PuzGameLobby extends Room {
  maxClients = 8;

  private lobbyPlayers: Record<string, PlayerData> = {};
  private lobbyName: string = '';
  private lobbyOpen: boolean = true;
  private lobbyPassword: string | null = null;

  async onCreate(options: any) {
    this.lobbyName = options.name || 'Room';
    this.lobbyOpen = options.open !== false;
    this.lobbyPassword = options.password || null;

    // Private rooms (password-protected) are hidden from the built-in LobbyRoom list.
    // Users join them via "Join with Code" + room ID.
    if (this.lobbyPassword) {
      await this.setPrivate(true);
    }

    await this.setMetadata({ name: this.lobbyName, open: this.lobbyOpen, players: 0 });

    // Client sends this after registering handlers to get the initial room state (avoids race).
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
        const gameRoom = await matchMaker.createRoom("puz_room", {});
        this.broadcast('room:launch:start', {});
        setTimeout(() => {
          this.broadcast('room:game:start', { roomId: gameRoom.roomId });
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
    // Password check — throw to reject join before player is added.
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

    // Update metadata so built-in LobbyRoom broadcasts the player count change.
    await this.setMetadata({ players: Object.keys(this.lobbyPlayers).length });

    if (!isMaster) {
      this.broadcast('room:player:join', { player: this.serializePlayer(pd) }, { except: client });
      this.broadcast('room:state', this.serializeRoom());
    }
    // The joining client sends "room:getState" after registering handlers.
  }

  async onLeave(client: Client, _consented: boolean) {
    const p = this.lobbyPlayers[client.sessionId];
    if (!p) return;
    delete this.lobbyPlayers[client.sessionId];

    await this.setMetadata({ players: Object.keys(this.lobbyPlayers).length });

    if (Object.keys(this.lobbyPlayers).length === 0) return;

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
      open: this.lobbyOpen,
      master: players.find(p => p.master)?.id || '',
      players: players.map(this.serializePlayer.bind(this)),
    };
  }
}
