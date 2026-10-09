import type { Metadata } from "next";
import StaffJoin from "@/components/StaffJoin";

// Where a team member lands from the receptionist's "join the call" email
// (#22, agent-worker/staff_call.py): the link's fragment holds their LiveKit
// token. Mobile first: they're likely answering from their phone.
export const metadata: Metadata = {
  title: "Join the kiosk call",
  robots: { index: false, follow: false },
};

export default function JoinPage() {
  return <StaffJoin />;
}
