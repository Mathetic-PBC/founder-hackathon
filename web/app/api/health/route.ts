// GET /api/health → lets a client check it can reach the deployment before anyone talks to it
export function GET() {
  return Response.json({ ok: true });
}
