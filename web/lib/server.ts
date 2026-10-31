import OpenAI from "openai";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Created per call, not at module scope: at module scope they throw during
// `next build` when the env vars aren't set.
export function openai() {
  return new OpenAI();
}

export function supabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Every route except /api/health requires the shared token. Fails closed if
// BART_TOKEN isn't configured, so a fresh deploy never exposes the OpenAI key.
export function unauthorized(req: Request): Response | null {
  const token = process.env.BART_TOKEN;
  if (token && req.headers.get("x-bart-token") === token) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
