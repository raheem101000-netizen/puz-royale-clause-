import { Room, Client, matchMaker } from "@colyseus/core";
import { authenticateGameToken, PuzAuth } from "../auth";
import { issueLaunchTicket } from "../launchTickets";
import { puzLobbyDisplayPrize } from "../prize";

interface PlayerData {
  id: string;
  userId: number; // real tenten.run account (from the login handoff token)
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
  // Set when the host presses Start: from then on the room code stops working
  // (lock() makes the matchmaker refuse joinById; onJoin also checks this for
  // a join already in flight). A full lobby (maxClients) is refused by
  // Colyseus itself.
  private launched = false;
  // Accounts the host removed: they can't come back into this lobby.
  private kickedUserIds = new Set<number>();

  // Runs during matchmaking, before any seat is reserved, so a player who
  // isn't logged in on tenten.run never gets a lobby created or joined.
  static async onAuth(token: string, options: any) {
    return authenticateGameToken(token, options?.playerId);
  }

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
      const players = Object.values(this.lobbyPlayers);
      // Ready-check: every player except the host must have pressed Ready
      // (the host starts instead of readying). Enforced here for every
      // launch — a client flag can't skip it.
      if (!players.filter(pp => !pp.master).every(pp => pp.ready)) {
        client.send('room:error', { message: 'Waiting for every player to be ready' });
        return;
      }
      if (this.launched) return;
      this.launched = true;
      await this.lock();
      try {
        const mapSize = Math.min(16, Math.max(2, parseInt(data?.mapSize) || 8));
        const gameRoom = await matchMaker.createRoom("puz_room", {
          mapSize,
          launchTicket: issueLaunchTicket(), // proves this room came from a lobby, not a client
          // The accounts in this lobby at launch: the only ones who may play the
          // match, and what its start waits for (see PuzRoom.maybeStart).
          rosterUserIds: [...new Set(players.map(pp => pp.userId))],
        });
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
        this.launched = false;
        await this.unlock();
        client.send('room:error', { message: 'Failed to start game' });
      }
    });

    // Host kick: only the host, never themselves; the removed player is told
    // why, disconnected from this lobby, and can't rejoin it.
    this.onMessage("room:kick", (client: Client, data: any) => {
      const p = this.lobbyPlayers[client.sessionId];
      if (!p || !p.master) { client.send('room:error', { message: 'Only the host can remove players' }); return; }
      if (this.launched) return;
      const targetId = String(data?.id || '');
      if (targetId === client.sessionId) { client.send('room:error', { message: "You can't remove yourself" }); return; }
      const target = this.lobbyPlayers[targetId];
      if (!target) { client.send('room:error', { message: 'Player not found' }); return; }
      this.kickedUserIds.add(target.userId);
      const targetClient = this.clients.find(c => c.sessionId === targetId);
      targetClient?.send('room:kicked', { message: 'You were removed by the host' });
      targetClient?.leave(4000);
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

  async onJoin(client: Client, options: any, auth: PuzAuth) {
    if (this.launched) {
      throw new Error("This match has already started");
    }
    if (this.kickedUserIds.has(auth.userId)) {
      throw new Error("You were removed from this room by the host");
    }
    if (this.lobbyPassword && options.password !== this.lobbyPassword) {
      throw new Error("Wrong password");
    }
    // One account, one seat (checked and claimed before any await).
    if (Object.values(this.lobbyPlayers).some(p => p.userId === auth.userId)) {
      throw new Error("You're already in this room");
    }

    const isMaster = Object.keys(this.lobbyPlayers).length === 0;
    const pd: PlayerData = {
      id: client.sessionId,
      userId: auth.userId,
      name: auth.displayName,
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
      // What a win pays if this many players start — from the server's one
      // prize formula, so the lobby can't disagree with what's paid.
      prize: puzLobbyDisplayPrize(players.length),
    };
  }
}
