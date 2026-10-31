// iMessage through Photon (Beta / 2.0 API: https://photon.codes/docs/beta). A shared Photon line can't send
// the first message: it only answers people who have texted it. So a send finds the person's latest
// message to the line and replies in that conversation, as that line.

// PHOTON_API_BASE only exists so tests can point this at a local stub
const api = () => process.env.PHOTON_API_BASE ?? "https://api.photon.codes/v1";

// Photon answers errors as problem+json: { status, code, title, detail?, issues? }
class PhotonError extends Error {
  status?: number;
  code?: string;
  issues?: { message?: string; path?: string }[];
  constructor(message: string, problem: { status?: number; code?: string; issues?: { message?: string; path?: string }[] } = {}) {
    super(message);
    this.status = problem.status;
    this.code = problem.code;
    this.issues = problem.issues;
  }
}

async function photon(path: string, init: RequestInit = {}) {
  const key = process.env.PHOTON_API_KEY;
  const project = process.env.PHOTON_PROJECT_ID;
  if (!key || !project) throw new PhotonError("PHOTON_API_KEY and PHOTON_PROJECT_ID must be set");
  const res = await fetch(`${api()}/projects/${project}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PhotonError(`Photon ${res.status}: ${body.detail ?? body.title ?? res.statusText}`, {
      status: res.status,
      code: typeof body.code === "string" ? body.code : undefined,
      issues: Array.isArray(body.issues) ? body.issues : undefined,
    });
  }
  return body;
}

interface ReceivedMessage {
  id: string;
  sentBy: { handle: string };
  receivedBy: { id: string };
  space: { id: string };
}

const digits = (phone: string) => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

// Several texts, in order, as separate messages in the conversation that number started with the line.
// Returns Photon's message ids. Idempotency keys are `${keyPrefix}:${index}`, so a retry doesn't double-send.
export async function sendIMessages(toPhone: string, texts: string[], keyPrefix: string): Promise<string[]> {
  const page = await photon(`/messages?direction=received&platform=imessage&order=desc&pageSize=100`);
  const last = (page.items as ReceivedMessage[]).find((m) => digits(m.sentBy?.handle ?? "") === digits(toPhone));
  if (!last) {
    const line = process.env.PHOTON_AGENT_HANDLE ?? "Bart's number";
    throw new PhotonError(`They have to text ${line} once before Bart can message them.`);
  }
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) {
    const sent = await photon(`/messages`, {
      method: "POST",
      headers: { "idempotency-key": `${keyPrefix}:${i}` },
      body: JSON.stringify({ spaceId: last.space.id, senderId: last.receivedBy.id, content: { type: "text", format: "plain", text } }),
    });
    ids.push(sent.id);
  }
  return ids;
}

export async function sendIMessage(toPhone: string, text: string, idempotencyKey: string): Promise<string> {
  const [id] = await sendIMessages(toPhone, [text], idempotencyKey);
  return id;
}

// Shared-line assignments: who is on the team's line. Each one maps a person's handle (E.164 phone or iMessage
// email) to a pooled Photon number and uses a seat of the plan. The person must text that number once before
// the line can message them.

export interface Assignment {
  assignmentId: string;
  handle: string;
  assignedPhoneNumber: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  createdAt: string;
  releasedAt?: string;
}

export async function listAssignments(): Promise<Assignment[]> {
  const all: Assignment[] = [];
  let token: string | undefined;
  do {
    const page = await photon(`/platforms/imessage/assignments?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    all.push(...((page.assignments ?? []) as Assignment[]));
    token = page.nextPageToken;
  } while (token);
  return all.filter((a) => !a.releasedAt);
}

export interface AssignInput {
  handle: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

// POST /platforms/imessage/assignments. Consumes a seat; callers must only run it on an explicit user action.
export async function assignToLine(input: AssignInput, idempotencyKey: string): Promise<Assignment> {
  // The body allows no extra keys, and the optional strings must be non-empty
  const body: Record<string, string> = { handle: input.handle };
  if (input.email?.trim()) body.email = input.email.trim();
  if (input.firstName?.trim()) body.firstName = input.firstName.trim().slice(0, 100);
  if (input.lastName?.trim()) body.lastName = input.lastName.trim().slice(0, 100);
  return photon(`/platforms/imessage/assignments`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
}

export function sameHandle(a: string, b: string) {
  if (a.includes("@") || b.includes("@")) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return digits(a) === digits(b);
}

// A sentence for the dashboard, from the error codes in Photon's OpenAPI spec for the assignment endpoint
export function explainPhotonError(err: PhotonError): string {
  const why: Record<string, string> = {
    SHARED_LINE_CAP_EXCEEDED: "Every shared-line seat on the Photon plan is in use.",
    SHARED_LINE_POOL_EXHAUSTED: "Photon has no shared lines free right now. Try again later.",
    BILLING_NOT_PROVISIONED: "The Photon plan's billing isn't set up.",
    BILLING_ENTITLEMENTS_PENDING: "The Photon plan is still being provisioned. Try again in a few minutes.",
    IMESSAGE_MODE_DEDICATED: "This Photon project uses a dedicated line, so people can't be added to a shared one.",
    PROJECT_CLOSING: "The Photon project is being closed.",
    ASSIGNMENT_EXISTS: "They're already on the line.",
    NOT_AUTHENTICATED: "Photon rejected the API key.",
    FORBIDDEN: "The Photon key isn't allowed to add people (it needs platforms:write on this project).",
    INSUFFICIENT_SCOPE: "The Photon key isn't allowed to add people (it needs platforms:write on this project).",
    RESOURCE_MISMATCH: "The Photon key belongs to a different project than PHOTON_PROJECT_ID.",
    RATE_LIMITED: "Photon is rate-limiting requests. Wait a moment and try again.",
  };
  const byStatus: Record<number, string> = {
    402: "Photon says the plan needs payment before more people can be added.",
    403: why.FORBIDDEN,
  };
  const issues = err.issues
    ?.map((i) => [i.path, i.message?.replace(/\.$/, "")].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
  const reason =
    (err.code && why[err.code]) ??
    (err.code === "VALIDATION_FAILED" ? `Photon didn't accept the details${issues ? `: ${issues}` : ""}.` : undefined) ??
    (err.status ? byStatus[err.status] : undefined) ??
    "Photon didn't accept the request.";
  return `${reason} (${err.message}${err.code ? `, ${err.code}` : ""})`;
}

export { PhotonError };
