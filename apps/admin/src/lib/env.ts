/** The API origin, e.g. https://lever.example.dev. Same-origin when unset. */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/$/, "");
