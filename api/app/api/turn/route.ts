import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

// One turn: Pi uploads a spoken question (+ optional page photo), gets spoken reply back.
//   POST /api/turn  multipart: audio (required), image (optional jpeg)
//   header x-turn-secret: must match TURN_SECRET
//   → audio/mpeg, with X-Question / X-Transcript headers for debugging

// No `runtime` export: Next 16's cacheComponents rejects it, and Node is the default anyway.
export const maxDuration = 60;

const CHAT_MODEL = process.env.CHAT_MODEL ?? "gpt-4.1-mini";
const TTS_VOICE = process.env.TTS_VOICE ?? "alloy";

const SYSTEM_PROMPT =
  "You are a reading companion. The user is holding a physical book; if an image is attached, it is the page they're on. Answer in a few short, spoken-style sentences. No markdown, lists or headings — your reply is read aloud.";

export async function POST(req: Request) {
  const secret = process.env.TURN_SECRET;
  if (!secret || req.headers.get("x-turn-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const audio = form.get("audio");
  const image = form.get("image");
  if (!(audio instanceof File) || audio.size === 0) {
    return Response.json({ error: "missing audio file" }, { status: 400 });
  }

  try {
    // Created per request: at module scope it throws during `next build` if the key isn't set.
    const openai = new OpenAI();

    // 1. speech → text
    const { text: question } = await openai.audio.transcriptions.create({
      file: audio,
      model: "gpt-4o-mini-transcribe",
    });

    // 2. question + page photo → answer
    const content: ChatCompletionContentPart[] = [{ type: "text", text: question }];
    if (image instanceof File && image.size > 0) {
      const b64 = Buffer.from(await image.arrayBuffer()).toString("base64");
      const mime = image.type || "image/jpeg";
      content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
    }
    const chat = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    });
    const reply = chat.choices[0]?.message.content ?? "Sorry, I didn't catch that.";

    // 3. text → speech
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: TTS_VOICE,
      input: reply,
      response_format: "mp3",
    });

    return new Response(await speech.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Question": encodeURIComponent(question),
        "X-Transcript": encodeURIComponent(reply),
      },
    });
  } catch (err) {
    console.error("turn failed", err);
    const message = err instanceof Error ? err.message : "unknown error";
    return Response.json({ error: message }, { status: 502 });
  }
}
