import { Room, Client, matchMaker } from "@colyseus/core";

interface PlayerData {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  paid: boolean;
  master: boolean;
}

interface PuzLobbyRoomData {
  id: string;
  name: string;
  open: boolean;
  password: string | null;
  master: string;
  players: Record<string, PlayerData>;
  started: boolean;
}

let roomCounter = 0;
function generateRoomId(): string {
  return 'room_' + (++roomCounter) + '_' + Date.now();
}

function serializePlayer(p: PlayerData) {
  return { id: p.id, name: p.name, color: p.color, ready: p.ready, paid: p.paid, master: p.master };
}

function serializeRoom(r: PuzLobbyRoomData) {
  return {
    id: r.id,
    name: r.name,
    open: r.open,
    master: r.master,
    started: r.started,
    players: Object.values(r.players).map(serializePlayer)
  };
}

export class PuzLobbyRoom extends Room {
  autoDispose = false;
  maxClients = 500;

  private lobbyRooms: Record<string, PuzLobbyRoomData> = {};
  private clientRoom = new Map<string, string>();
  private clientData = new Map<string, PlayerData>();

  onCreate() {
    this.onMessage("room:list", (client: Client) => {
      client.send("room:list", { rooms: this.serializeList() });
    });

    this.onMessage("room:create", (client: Client, data: any) => {
      if (this.clientRoom.has(client.sessionId)) return;
      const roomId = generateRoomId();
      const pd: PlayerData = {
        id: client.sessionId,
        name: data.player?.name || 'Player',
        color: data.player?.color || '#FF4444',
        ready: false, paid: false, master: true
      };
      const room: PuzLobbyRoomData = {
        id: roomId,
        name: data.name || 'Room ' + roomCounter,
        open: data.open !== false,
        password: data.password || null,
        master: client.sessionId,
        players: { [client.sessionId]: pd },
        started: false
      };
      this.lobbyRooms[roomId] = room;
      this.clientRoom.set(client.sessionId, roomId);
      this.clientData.set(client.sessionId, pd);

      client.send('room:join', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.broadcast('room:open', { room: { id: roomId, name: room.name, open: room.open, players: 1 } });
      this.broadcastList();
    });

    this.onMessage("room:join", (client: Client, data: any) => {
      if (this.clientRoom.has(client.sessionId)) return;
      const roomId = data.room;
      const room = this.lobbyRooms[roomId];
      if (!room) { client.send('room:error', { message: 'Room not found' }); return; }
      if (room.started) { client.send('room:error', { message: 'Game already started' }); return; }
      if (room.password && room.password !== data.password) { client.send('room:error', { message: 'Wrong password' }); return; }
      if (Object.keys(room.players).length >= 8) { client.send('room:error', { message: 'Room is full' }); return; }

      const pd: PlayerData = {
        id: client.sessionId,
        name: data.player?.name || 'Player',
        color: data.player?.color || '#4CFF6C',
        ready: false, paid: false, master: false
      };
      room.players[client.sessionId] = pd;
      this.clientRoom.set(client.sessionId, roomId);
      this.clientData.set(client.sessionId, pd);

      client.send('room:join', { room: serializeRoom(room), player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:player:join', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
      this.broadcast('room:update', { id: roomId, players: Object.keys(room.players).length });
    });

    this.onMessage("room:ready", (client: Client) => {
      const roomId = this.clientRoom.get(client.sessionId);
      if (!roomId) return;
      const room = this.lobbyRooms[roomId];
      if (!room) return;
      const pd = room.players[client.sessionId];
      if (!pd) return;
      pd.ready = true; pd.paid = true;
      this.sendToRoom(room, 'room:player:ready', { player: serializePlayer(pd) });
      this.sendToRoom(room, 'room:state', serializeRoom(room));
    });

    this.onMessage("room:launch", async (client: Client, data: any) => {
      const roomId = this.clientRoom.get(client.sessionId);
      if (!roomId) return;
      const room = this.lobbyRooms[roomId];
      if (!room || room.started) return;
      if (room.master !== client.sessionId) return;

      const isDev = data && data.dev === true;
      const players = Object.values(room.players);
      if (!isDev) {
        const readyCount = players.filter(p => p.ready).length;
        if (readyCount < 1) {
          client.send('room:error', { message: 'Need at least 1 ready player' });
          return;
        }
      }

      try {
        const gameRoom = await matchMaker.createRoom("puz_room", {});
        room.started = true;
        this.sendToRoom(room, 'room:launch:start', {});
        this.broadcastList();
        setTimeout(() => {
          this.sendToRoom(room, 'room:game:start', {
            roomId: gameRoom.roomId,
            players: players.map(serializePlayer)
          });
          setTimeout(() => { delete this.lobbyRooms[roomId]; }, 30000);
        }, 3000);
      } catch (e) {
        client.send('room:error', { message: 'Failed to start game' });
      }
    });

    this.onMessage("room:talk", (client: Client, data: any) => {
      const roomId = this.clientRoom.get(client.sessionId);
      if (!roomId) return;
      const room = this.lobbyRooms[roomId];
      if (!room) return;
      const pd = this.clientData.get(client.sessionId);
      this.sendToRoom(room, 'room:talk', {
        player: pd?.name || 'Unknown',
        content: String(data?.content || '').slice(0, 200)
      });
    });

    this.onMessage("room:leave", (client: Client) => {
      this.handleLeave(client);
    });
  }

  onJoin(_client: Client) {}

  onLeave(client: Client) {
    this.handleLeave(client);
  }

  private handleLeave(client: Client) {
    const roomId = this.clientRoom.get(client.sessionId);
    if (!roomId) { this.clientData.delete(client.sessionId); return; }
    const room = this.lobbyRooms[roomId];
    if (!room) { this.clientRoom.delete(client.sessionId); this.clientData.delete(client.sessionId); return; }

    delete room.players[client.sessionId];
    this.clientRoom.delete(client.sessionId);
    this.clientData.delete(client.sessionId);

    this.sendToRoom(room, 'room:player:leave', { player: client.sessionId });

    if (Object.keys(room.players).length === 0) {
      delete this.lobbyRooms[roomId];
      this.broadcast('room:close', { id: roomId });
    } else if (room.master === client.sessionId) {
      const newMasterId = Object.keys(room.players)[0];
      room.master = newMasterId;
      room.players[newMasterId].master = true;
      const masterClient = this.clients.find(c => c.sessionId === newMasterId);
      masterClient?.send('room:master', { master: newMasterId });
    }
    this.sendToRoom(room, 'room:state', serializeRoom(room));
    this.broadcast('room:update', { id: roomId, players: Object.keys(room.players).length });
  }

  private serializeList() {
    return Object.values(this.lobbyRooms)
      .filter(r => r.open && !r.started)
      .map(r => ({
        id: r.id,
        name: r.name,
        players: Object.keys(r.players).length,
        open: r.open
      }));
  }

  private broadcastList() {
    this.broadcast('room:list', { rooms: this.serializeList() });
  }

  private sendToRoom(room: PuzLobbyRoomData, event: string, data: any) {
    for (const sessionId of Object.keys(room.players)) {
      const c = this.clients.find(cl => cl.sessionId === sessionId);
      c?.send(event, data);
    }
  }
}
