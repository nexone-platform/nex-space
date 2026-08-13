// Where the API lives, and the session token.
//
// In production nginx reverse-proxies the API on the same origin (/auth, /me,
// /workspaces), so relative URLs work over any host, port or protocol. Only dev
// needs the explicit port. This used to be copied into every module that talked
// to the API, which is how one copy ended up defaulting to localhost over http.
const env = (import.meta as any).env ?? {};

export const API = (env.VITE_API_URL as string) || (env.DEV ? "http://localhost:3001" : "");

export const TOKEN_KEY = "nexspace-token";
export const authToken = () => localStorage.getItem(TOKEN_KEY);

export const authHeaders = () => ({
  "Content-Type": "application/json",
  ...(authToken() ? { Authorization: "Bearer " + authToken()! } : {}),
});
