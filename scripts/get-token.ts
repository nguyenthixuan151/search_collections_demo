// scripts/get-token.ts
// Calls POST /api/auth/widget-token and returns the auth token. The server authenticates
// using USER_NAME/PASSWORD from its own environment (PASSWORD is the user's stored
// password hash, compared directly) — this script doesn't need or send any credentials.
//
//   Env:
//     API_BASE_URL   -> defaults to http://localhost:3000
//
//   Run directly to print the token:
//     npx tsx scripts/get-token.ts

export async function login(): Promise<string> {
    const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/auth/widget-token`, { method: 'POST' });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Login failed (${res.status}): ${body.error ?? res.statusText}`);
    }

    const { token } = (await res.json()) as { token: string };
    return token;
}

if (require.main === module) {
    login()
        .then((token) => console.log(token))
        .catch((err) => {
            console.error(err.message);
            process.exit(1);
        });
}
