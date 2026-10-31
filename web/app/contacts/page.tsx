import { assignContact } from "@/app/actions";
import { dashboardDb } from "@/lib/dashboard";
import { formatPhone } from "@/lib/forms";
import { listAssignments, sameHandle, type Assignment } from "@/lib/photon";
import { ContactForm, LineStatus } from "../_ui/forms";

export const metadata = { title: "Contacts" };

// Contacts are who Bart can text (share_with_friend). Being on the team's Photon line is what makes that possible,
// so each row shows the line state, read live from Photon's assignment list and matched by number.
export default async function ContactsPage() {
  const db = await dashboardDb();
  const [contacts, line] = await Promise.all([
    db.from("contacts").select("id, name, phone").order("created_at"),
    listAssignments().then(
      (assignments) => ({ assignments, error: null }),
      (err: unknown) => ({ assignments: [] as Assignment[], error: err instanceof Error ? err.message : String(err) }),
    ),
  ]);
  if (contacts.error) throw contacts.error;
  const rows = (contacts.data ?? []).map((c) => ({ ...c, assignment: line.assignments.find((a) => sameHandle(a.handle, c.phone)) }));

  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="title">Contacts</h1>

        {line.error && (
          <p className="alert" role="alert">
            Couldn’t reach Photon: {line.error}
          </p>
        )}

        {rows.length > 0 && (
          <ul className="list">
            {rows.map((c) => (
              <li className="row" key={c.id}>
                <span className={c.assignment ? "mark" : "mark mark-off"} aria-hidden />
                <div className="row-main">
                  <span className="row-name">{c.name}</span>
                  <span className="row-hint">{formatPhone(c.phone)}</span>
                </div>
                {!line.error && (
                  <LineStatus action={assignContact.bind(null, c.id)} onLine={!!c.assignment} line={c.assignment?.assignedPhoneNumber} />
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="card">
          <div className="card-head">
            <div className="card-title">Add a contact</div>
            <div className="card-rule" />
          </div>
          <div className="card-body">
            <ContactForm />
          </div>
        </div>
      </div>
    </div>
  );
}
