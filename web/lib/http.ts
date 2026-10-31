// Agent and highlight routes accept either JSON or multipart (multipart when a photo is attached).
// Multipart fields that hold JSON (`args`) are parsed.
export async function readBody(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    const fields: Record<string, unknown> = {};
    let image: { bytes: Buffer; mime: string } | null = null;
    for (const [key, value] of form) {
      if (value instanceof File) {
        if (key === "image" && value.size > 0) {
          image = { bytes: Buffer.from(await value.arrayBuffer()), mime: value.type || "image/jpeg" };
        }
      } else {
        fields[key] = key === "args" ? safeJson(value) : value;
      }
    }
    return { fields, image };
  }
  const fields = type.includes("application/json") ? ((await req.json()) as Record<string, unknown>) : {};
  return { fields, image: null };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
export const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
