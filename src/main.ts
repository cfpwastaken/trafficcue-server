import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db";
import { post } from "./ai";
import { rateLimiter } from "hono-rate-limiter";
import { getTokenUID, verifyToken } from "./auth";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import type { WSContext } from "hono/ws";

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

async function setupDB() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS reviews (
			id SERIAL PRIMARY KEY,
			user_id TEXT NOT NULL,
			latitude FLOAT NOT NULL,
			longitude FLOAT NOT NULL,
			rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
			comment TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES "user"(id)
		);
	`);
}

await setupDB();

app.use(
	"/api/*", // or replace with "*" to enable cors for all routes
	cors({
		origin: "*",
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["POST", "GET", "OPTIONS"],
		exposeHeaders: ["Content-Length"],
		maxAge: 600,
		credentials: true,
	}),
);

app.get("/api/config", (c) => {
	const capabilities: string[] = ["auth", "reviews"];

	if(process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
		capabilities.push("ai");
	}

	if(process.env.TANKERKOENIG_API_KEY) {
		capabilities.push("fuel");
	}

	return c.json({
		name: "TrafficCue Server",
		version: "0",
		capabilities,
		oidc: process.env.OIDC_ENABLED ? {
			AUTH_URL: process.env.OIDC_AUTH_URL,
			CLIENT_ID: process.env.OIDC_CLIENT_ID,
			TOKEN_URL: process.env.OIDC_TOKEN_URL
		} : undefined
	})
})

app.get("/api/reviews", async (c) => {
	let {lat, lon} = c.req.query();
	if (!lat || !lon) {
		return c.json({ error: "Latitude and longitude are required" }, 400);
	}
	// Remove unnecessary precision from lat/lon
	lat = parseFloat(lat).toFixed(6);
	lon = parseFloat(lon).toFixed(6);
	console.log(`Fetching reviews for lat: ${lat}, lon: ${lon}`);
	const res = await pool.query(
		"SELECT * FROM reviews WHERE latitude = $1 AND longitude = $2",
		[lat, lon],
	);
	return c.json(await Promise.all(res.rows.map(async (row) => {
		return {
			id: row.id,
			user_id: row.user_id,
			rating: row.rating,
			comment: row.comment,
			created_at: row.created_at,
			username: "Me" // TODO: Sync OIDC users with the database
		};
	})));
});

app.post("/api/review", async (c) => {
	const { rating, comment, lat, lon } = await c.req.json();
	if (!rating || !lat || !lon) {
		return c.json({ error: "Rating, latitude, and longitude are required" }, 400);
	}

	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const token = authHeader.split(" ")[1];
	if (!token) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	const isValid = await verifyToken(token);
	if (!isValid) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const uid = await getTokenUID(token);
	if (!uid) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const res = await pool.query(
		"INSERT INTO reviews (user_id, latitude, longitude, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *",
		[uid, lat, lon, rating, comment],
	);

	return c.json(res.rows[0]);
})

if(process.env.TANKERKOENIG_API_KEY) {
	app.get("/api/fuel/list", async (c) => {
		// pass GET query parameters to the tankerkoenig API
		const params = new URLSearchParams(c.req.query());
		params.set("apikey", process.env.TANKERKOENIG_API_KEY!);
		const url = `https://creativecommons.tankerkoenig.de/json/list.php?${params.toString()}`;
		const response = await fetch(url);
		if (!response.ok) {
			return c.json({ error: "Failed to fetch fuel stations" });
		}
		const data = await response.json();
		return c.json(data as Record<string, unknown>);
	});
	app.get("/api/fuel/prices", async (c) => {
		// pass GET query parameters to the tankerkoenig API
		const params = new URLSearchParams(c.req.query());
		params.set("apikey", process.env.TANKERKOENIG_API_KEY!);
		const url = `https://creativecommons.tankerkoenig.de/json/prices.php?${params.toString()}`;
		const response = await fetch(url);
		if (!response.ok) {
			return c.json({ error: "Failed to fetch fuel prices" });
		}
		const data = await response.json();
		return c.json(data as Record<string, unknown>);
	});
	app.get("/api/fuel/detail", async (c) => {
		// pass GET query parameters to the tankerkoenig API
		const params = new URLSearchParams(c.req.query());
		params.set("apikey", process.env.TANKERKOENIG_API_KEY!);
		const url = `https://creativecommons.tankerkoenig.de/json/detail.php?${params.toString()}`;
		const response = await fetch(url);
		if (!response.ok) {
			return c.json({ error: "Failed to fetch station details" });
		}
		const data = await response.json();
		return c.json(data as Record<string, unknown>);
	});
}

if(process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
	app.use("/api/ai", rateLimiter({
		windowMs: 60 * 1000, // 1 minute
		limit: 50, // 10 requests per minute
		standardHeaders: "draft-6",
		keyGenerator: (c) => "global"
	}))
	app.post("/api/ai", post);
}

let wsSubscribers: Record<string, WSContext<ServerWebSocket>[]> = {};

app.get("/api/ws", upgradeWebSocket((c) => {
	let advertising = "";
	return {
		onOpen(e, ws) {
			console.log("WebSocket connection opened");
			ws.send(JSON.stringify({ type: "welcome", message: "Welcome to TrafficCue WebSocket!" }));
		},
		onMessage(e, ws) {
			const data = JSON.parse(e.data.toString());
			console.log("WebSocket message received:", data);

			if (data.type === "advertise") {
				const code = data.code || randomCode();
				wsSubscribers[code] = wsSubscribers[code] || [];
				advertising = code;
				ws.send(JSON.stringify({ type: "advertising", code }));
			} else if (data.type === "subscribe") {
				const code = data.code;
				if (!code || !wsSubscribers[code]) {
					ws.send(JSON.stringify({ type: "error", message: "Invalid or unknown code" }));
					return;
				}
				wsSubscribers[code].push(ws);
				ws.send(JSON.stringify({ type: "subscribed", code }));
			} else if (data.type === "location") {
				const subscribers = wsSubscribers[advertising] || [];
				subscribers.forEach(subscriber => {
					if (subscriber !== ws) {
						subscriber.send(JSON.stringify({ type: "location", location: data.location, route: data.route }));
					}
				});
			} else {
				ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
			}
		},
		onClose(e, ws) {
			// If they are subscribing, remove them from the subscribers list
			for (const code in wsSubscribers) {
				if (wsSubscribers[code]) {
					wsSubscribers[code] = wsSubscribers[code].filter(subscriber => subscriber !== ws);
					if (wsSubscribers[code].length === 0) {
						delete wsSubscribers[code];
					}
				}
			}
		}
	}
}));

function randomCode(length: number = 6): string {
	const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += characters.charAt(Math.floor(Math.random() * characters.length));
	}
	return result;
}

app.get("/", (c) => {
	return c.text("TrafficCue Server");
})

export default {
	fetch: app.fetch,
	websocket
}