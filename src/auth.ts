import { decode, verify, type Algorithm } from "jsonwebtoken";
import jwkToPem, { type JWK } from "jwk-to-pem";

const JWKS = process.env.OIDC_JWKS_URL || "";

interface JWKSResponse {
	keys: {
		kid: string;
		kty: string;
		use: string;
		alg: Algorithm;
		n: string;
		e: string;
	}[];
}

export async function verifyToken(token: string): Promise<boolean> {
	const decoded = decode(token, { complete: true });

	const jwks = await fetch(JWKS).then(
		(res) => res.json() as Promise<JWKSResponse>,
	);
	if (!decoded || !decoded.header || !decoded.header.kid) {
		return false;
	}
	const key = jwks.keys.find((k) => k.kid === decoded.header.kid);
	if (!key) {
		return false;
	}
	const pem = jwkToPem(key as JWK);
	try {
		const res = verify(token, pem, { algorithms: [key.alg] });
		console.log(res);
		return typeof res === "object" && "sub" in res;
	} catch (_err) {
		return false;
	}
}

export function getTokenUID(token: string): string | null {
	const decoded = decode(token);
	if (typeof decoded === "object" && decoded !== null && "sub" in decoded) {
		return decoded.sub as string;
	}
	return null;
}
