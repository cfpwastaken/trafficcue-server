import { Hono, type Context } from "hono";
import { streamText, tool } from "ai";
import { google } from "@ai-sdk/google";
import { stream } from "hono/streaming";
import z from "zod";

const app = new Hono();

export type OverpassResult = {
	elements: OverpassElement[];
};

export type OverpassElement = {
	type: "node" | "way" | "relation";
	id: number;
	tags: Record<string, string>;
	lat?: number; // Only for nodes
	lon?: number; // Only for nodes
	nodes?: number[]; // Only for ways
	center?: {
		lat: number; // Only for relations
		lon: number; // Only for relations
	};
};

const OVERPASS_SERVER = "https://overpass-api.de/api/interpreter";

export async function fetchPOI(
	lat: number,
	lon: number,
	radius: number,
) {
	return await fetch(OVERPASS_SERVER, {
		method: "POST",
		body: `[out:json];
(
  node(around:${radius}, ${lat}, ${lon})["amenity"]["name"];
  way(around:${radius}, ${lat}, ${lon})["amenity"]["name"];
  relation(around:${radius}, ${lat}, ${lon})["amenity"]["name"];
  node(around:${radius}, ${lat}, ${lon})["shop"]["name"];
  way(around:${radius}, ${lat}, ${lon})["shop"]["name"];
  relation(around:${radius}, ${lat}, ${lon})["shop"]["name"];
  node(around:${radius}, ${lat}, ${lon})["building"]["building"!="garage"];
  way(around:${radius}, ${lat}, ${lon})["building"]["building"!="garage"];
  node(around:${radius}, ${lat}, ${lon})["amenity"="parking"];
  way(around:${radius}, ${lat}, ${lon})["amenity"="parking"];
);
out center tags;`
	}).then(res => res.json() as Promise<OverpassResult>);
}

function getDistance(aLat: number, aLon: number, lat: number, lon: number): number {
	const R = 6371e3; // Earth radius in meters
	const φ1 = lat * Math.PI / 180;
	const φ2 = aLat * Math.PI / 180;
	const Δφ = (aLat - lat) * Math.PI / 180;
	const Δλ = (aLon - lon) * Math.PI / 180;

	const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

	return R * c;
}

function sortByDistance(elements: OverpassElement[], lat: number, lng: number): OverpassElement[] {
	return elements.sort((a: OverpassElement, b: OverpassElement) => {
		const aLoc = a.center || a;
		const bLoc = b.center || b;
		return getDistance(aLoc.lat!, aLoc.lon!, lat, lng) - getDistance(bLoc.lat!, bLoc.lon!, lat, lng);
	});
}

export async function post(c: Context) {

	const body = await c.req.json();
	const text = body.text ? body.text.trim() : "";
	const coords = body.coords;
	let tags: Record<string, string> | undefined = undefined;
	if(coords && coords.lat && coords.lon) {
		// fetch tags from OpenStreetMap using Overpass API
		console.log("Fetching POI for coordinates:", coords.lat, coords.lon);
		const res = await fetchPOI(coords.lat, coords.lon, 100);
		const poi = sortByDistance(res.elements, coords.lat, coords.lon);
		if(poi.length > 0) {
			tags = poi[0]?.tags ?? {}; // Use the first element's tags
			coords.lat = poi[0]?.lat ?? coords.lat; // Use the first element's lat if available
			coords.lon = poi[0]?.lon ?? coords.lon; // Use the first element's lon if available
		}
	}
	console.log("Received request with text:", text);
	const prompt = JSON.stringify({
		coords,
		tags,
		text
	}, null, 2)
	console.log("Generated prompt:", prompt);
	const result = streamText({
		onError: (error) => {
			console.error("Error in AI response:", error);
		},
		model: google("gemini-2.0-flash", {
			// useSearchGrounding: true,
		}), // key is in GOOGLE_GENERATIVE_AI_API_KEY env variable
		system: `You are a guide for a user who is trying to find places to visit.
You may be given OSM tags of a place and your task is to describe the place in a way that is useful for the user.
If not, the user might provide you with a description of a place they are looking for. Fetch the tags of the place using overpass in that case.
Do not guess the tags of the place, always fetch them using Overpass API. Note that places might be a node, way or relation. You should handle all of them correctly (by not fetching for just nodes).
You might get questions at the end of the tags by the user for you to answer.
In that case, focus on the question only. Do not describe the place if you get a question.
If there is no question from the user, describe the place based on the tags provided.
Do not guess an answer if the tags do not provide enough information. Instead, fetch the website of the place to get more information.
If the user asks for something extremely unlikely this place would have, you can tell them that it is unlikely to have that feature.
Do not mention the tags to the user, just answer the question.
If the user asks in a language other than English, answer in that language.
Use the provided tools to query OpenStreetMap data if necessary/the user asks for information outside the provided place like asking what is around it.
For using the overpass tool, make sure to query for ways and relations as well, not just nodes.
DO NOT guess node, way or relation IDs when using the overpass tool, always use coordinates or names provided by the user.
IF THE USER DOES NOT PROVIDE COORDINATES, DO NOT GUESS THEM, INSTEAD USE THE PROVIDED TEXT TO QUERY OSM DATA. USE CITY NAMES FOR EXAMPLE.
Location of the place is given to help with querying OSM data. Note that there might be multiple ways to tag something you search for.
Example: amenity=kiosk and shop=kiosk are both valid ways to tag a kiosk.
DO NOT tell the user to use a mapping software or website, use the tools to query OSM data to answer the question.
If you would need to visit a website to answer the question, use the fetchWebsite tool to get the content of the website.

When describing a place, skip explaining the following tags as they are already displayed to the user: opening_hours, website, phone, email, any address tags
Focus on all other tags like wheelchair, amenity, healthcare:speciality, cuisine, etc.

When using tools, do not ask the user for confirmation, just use them directly.

The local date and time is ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}. The users language is German.`,
		prompt,
		maxSteps: 5,
		tools: {
			overpass: tool({
				description: "Query OpenStreetMap data using Overpass API with the given Overpass QL query.",
				parameters: z.object({
					query: z.string().describe("The Overpass QL query to execute."),
				}),
				execute: async ({ query }) => {
					console.log("Executing Overpass API query:", query);
					const response = await fetch("https://overpass-api.de/api/interpreter", {
						method: "POST",
						headers: { "Content-Type": "text/plain" },
						body: query,
					});
					if (!response.ok) {
						throw new Error(`Overpass API request failed: ${response.status} ${response.statusText}`);
					}
					const data = await response.text();
					return data;
				}
			}),
			fetchWebsite: tool({
				description: "Fetch the raw HTML content of a website.",
				parameters: z.object({
					url: z.string().describe("The full URL to fetch (from the OSM tags)"),
				}),
				execute: async ({ url }) => {
					const res = await fetch(url, {
						method: "GET",
						headers: {
							"User-Agent": "Mozilla/5.0 (compatible; GeminiBot/1.0)",
						},
					});
		
					if (!res.ok) {
						throw new Error(`Failed to fetch site: ${res.status} ${res.statusText}`);
					}
		
					const text = await res.text();

					function stripHTML(html: string): string {
						// Remove script/style/head tags and their content
						html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
						html = html.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');
						html = html.replace(/<head[\s\S]*?>[\s\S]*?<\/head>/gi, '');
					
						// Strip all remaining HTML tags
						const text = html.replace(/<\/?[^>]+(>|$)/g, '');
					
						return text.replace(/\s+/g, ' ').trim().slice(0, 4000);
					}

					return stripHTML(text).slice(0, 5000); // avoid hitting token limit
				},
			})
		}
	})

	// Mark the response as a v1 data stream:
	c.header('X-Vercel-AI-Data-Stream', 'v1');
	c.header('Content-Type', 'text/plain; charset=utf-8');

	return stream(c, stream => stream.pipe(result.toDataStream()));
}