// Shared by the dashboard's server actions and its client forms, so nothing here may touch the server.

// What a form action hands back to its form. `values` refills the fields after an error
// (React resets an action form once the action finishes).
export interface FormState {
  error?: string;
  message?: string;
  assigned?: { name: string; handle: string; line: string };
  values?: Record<string, string>;
}

// "+1 415 555 0123", "(415) 555-0123" and "415.555.0123" → "+14155550123". Ten digits are taken as a US number.
export function toE164(raw: string): string | null {
  const s = raw.trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^[1-9]\d{6,14}$/.test(d) ? `+${d}` : null;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

// "+14155550123" → "+1 (415) 555-0123"; anything else is shown as stored
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}
