# TrafficCue Server

**The backend for the TrafficCue navigation app**  
Handles accounts, POI reviews, route sharing, MapAI, and more. All fully open and self-hostable.

---

## 🔧 What is this?

This is the backend server powering TrafficCue, the FOSS navigation app made for slow and special vehicles.

It handles:

- 🔐 Authentication (external OIDC server)
- 🗺️ POI reviews and ratings
- 🔗 Route/Location sharing between users
- 🧠 MapAI features

You can run this yourself to host your own instance, or contribute to the official one.

---

## 🚀 Quickstart

### Requirements

- Bun
- PostgreSQL

### Setup

Docker is coming soon!

1. Clone this repository
2. Run `bun install` to install dependencies
3. Launch the app at `src/main.ts` with the environment variables set:
	 - `GOOGLE_GENERATIVE_AI_API_KEY` (optional, to enable MapAI features. Its free at Google!)
	 - `TANKERKOENIG_API_KEY` (optional, to enable fuel price features. Its free!)
	 - `OIDC_ENABLED` (needs to be enabled for most features requiring authentication)
	 - `OIDC_AUTH_URL` (the Authentication URL of your OIDC server)
	 - `OIDC_CLIENT_ID` (the Client ID of your OIDC server)
	 - `OIDC_TOKEN_URL` (the Token URL of your OIDC server)
	 - `OIDC_JWKS_URL` (the JWKS/Certificate URL of your OIDC server)
	 - `REVIEWS_ENABLED` (optional, set to `true` to enable POI reviews by users, requires OIDC)

When configuring your OIDC server, make sure to enable Public Client and PCKE support.
