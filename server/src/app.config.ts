import { defineServer, defineRoom, monitor } from "colyseus";
import express from "express";
import path from "path";
import { PuzLobbyRoom } from "./rooms/PuzLobbyRoom";
import { PuzRoom } from "./rooms/PuzRoom";

export const server = defineServer({
    rooms: {
        puz_lobby: defineRoom(PuzLobbyRoom),
        puz_room:  defineRoom(PuzRoom),
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
