import { redirect } from "next/navigation";

// No dedicated marketing/home page in scope for this phase — the events
// list is the natural landing page for both signed-in and anonymous users.
export default function RootPage() {
  redirect("/events");
}
