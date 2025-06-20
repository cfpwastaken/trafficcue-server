import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { pool } from "./db";

export const auth = betterAuth({
	database: pool,
	emailAndPassword: {  
		enabled: true
	},
	plugins: [
		username({
			minUsernameLength: 3
		})
	]
});