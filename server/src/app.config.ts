import { defineServer, defineRoom, monitor, LobbyRoom } from "colyseus";
import { matchMaker } from "@colyseus/core";
import express from "express";
import path from "path";
import { Pool } from "pg";
import Stripe from "stripe";
import { PuzGameLobby } from "./rooms/PuzGameLobby";
import { PuzRoom } from "./rooms/PuzRoom";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const neonPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;

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
        // Stripe webhook — raw body must be read before any JSON middleware
        app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            const sig = req.headers["stripe-signature"] as string;
            let event: Stripe.Event;
            try {
                event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
            } catch (err: any) {
                res.status(400).send(`Webhook Error: ${err.message}`);
                return;
            }
            if (event.type === "checkout.session.completed") {
                const session = event.data.object as Stripe.Checkout.Session;
                if (neonPool) {
                    await neonPool.query(
                        "INSERT INTO sessions (game, mode, amount, stripe_payment_id) VALUES ($1, $2, $3, $4)",
                        ["Puz Royale", "multiplayer", 2.99, session.payment_intent]
                    ).catch(console.error);
                }
            }
            res.json({ received: true });
        });

        // Multiplayer checkout — $2.99
        app.post("/create-multiplayer-checkout", express.json(), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    line_items: [{ price_data: { currency: "usd", product_data: { name: "Puz Royale Multiplayer" }, unit_amount: 299 }, quantity: 1 }],
                    mode: "payment",
                    metadata: { mode: "multiplayer" },
                    success_url: `${process.env.BASE_URL}/rooms?paid=true&session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.BASE_URL}/rooms`,
                });
                res.json({ url: session.url });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        // Colyseus has no global "app"+"io"+"rooms" the way a plain
        // socket.io server does — matchMaker.stats is the built-in
        // equivalent (ccu = concurrent connected users, roomCount across
        // all room types).
        app.get("/status", (req, res) => {
            // Public, read-only status check polled cross-origin from the
            // admin dashboard — no sensitive data, so a wildcard is fine.
            res.set("Access-Control-Allow-Origin", "*");
            res.json({
                game: "Puz Royale",
                activePlayers: matchMaker.stats.local.ccu,
                activeRooms: matchMaker.stats.local.roomCount,
                timestamp: new Date().toISOString()
            });
        });

        // Winner prize claim form submission
        app.post("/submit-prize-claim", express.json(), async (req, res) => {
            const { winner_name, paypal_email, contact_email, notes, game, prize_amount } = req.body;
            if (neonPool) {
                await neonPool.query(
                    "INSERT INTO prize_claims (winner_name, paypal_email, contact_email, notes, game, prize_amount, claimed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())",
                    [winner_name, paypal_email || "", contact_email || "", notes || "", game, prize_amount]
                ).catch(console.error);
            }
            res.json({ success: true });
        });

        app.options("/admin/prize-claims", (_req, res) => { res.set("Access-Control-Allow-Origin","*").set("Access-Control-Allow-Methods","GET,OPTIONS").set("Access-Control-Allow-Headers","Content-Type").sendStatus(204); });
        app.options("/admin/mark-paid", (_req, res) => { res.set("Access-Control-Allow-Origin","*").set("Access-Control-Allow-Methods","POST,OPTIONS").set("Access-Control-Allow-Headers","Content-Type").sendStatus(204); });

        app.get("/admin/prize-claims", async (req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            if (req.query.key !== "TENTEN2025") { res.status(401).json({ error: "Unauthorized" }); return; }
            if (!neonPool) { res.json([]); return; }
            try {
                const result = await neonPool.query("SELECT * FROM prize_claims WHERE paid = false AND game = 'Puz Royale Multiplayer' ORDER BY claimed_at DESC");
                res.json(result.rows);
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        app.post("/admin/mark-paid", express.json(), async (req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            if (req.query.key !== "TENTEN2025") { res.status(401).json({ error: "Unauthorized" }); return; }
            if (!neonPool) { res.json({ success: false }); return; }
            try {
                await neonPool.query("UPDATE prize_claims SET paid = true WHERE id = $1", [req.body.id]);
                res.json({ success: true });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

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

    beforeListen: async () => {
        if (neonPool) {
            await neonPool.query(`
                CREATE TABLE IF NOT EXISTS prize_claims (
                    id SERIAL PRIMARY KEY,
                    winner_name TEXT NOT NULL,
                    paypal_email TEXT,
                    contact_email TEXT,
                    notes TEXT,
                    game TEXT NOT NULL,
                    prize_amount TEXT NOT NULL,
                    paid BOOLEAN DEFAULT FALSE,
                    claimed_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(console.error);
        }
    }
});

export default server;
