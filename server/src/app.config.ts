import { defineServer, defineRoom, monitor, LobbyRoom } from "colyseus";
import express from "express";
import path from "path";
import { PuzGameLobby } from "./rooms/PuzGameLobby";
import { PuzRoom } from "./rooms/PuzRoom";

export const server = defineServer({
    rooms: {
        // Built-in LobbyRoom: auto-broadcasts room list changes to all watching clients.
        lobby:          defineRoom(LobbyRoom),
        // PuzGameLobby: one instance per game lobby; enableRealtimeListing() makes the
        // built-in LobbyRoom push +/- events whenever a room is created/updated/removed.
        puz_game_lobby: defineRoom(PuzGameLobby).enableRealtimeListing(),
        puz_room:       defineRoom(PuzRoom),
    },

    express: (app) => {
        app.use("/colyseus", monitor());

        app.get('/', (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });
        app.get('/play-mp2', (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/play-mp2.html"));
        });

        app.use(express.static(path.join(__dirname, "../../client/dist")));

        app.get(/^(?!\/colyseus).*/, (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });
    },

    beforeListen: () => {}
});

export default server;
