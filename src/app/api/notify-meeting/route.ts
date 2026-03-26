import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const visitorName: string | null = body.visitorName ?? null;

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      console.error("[notify-meeting] ADMIN_EMAIL env var is not set");
      return NextResponse.json(
        { error: "Server misconfiguration: ADMIN_EMAIL not set" },
        { status: 500 }
      );
    }

    const displayName = visitorName ?? "An anonymous visitor";
    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    });

    const roomUrl =
      process.env.NEXT_PUBLIC_JITSI_ROOM_URL ?? "https://meet.jit.si/officemal-meeting";

    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
      to: adminEmail,
      subject: "Someone joined the meeting room",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #f9f9f9; border-radius: 12px;">
          <h2 style="margin: 0 0 16px; color: #1a1a1a;">Meeting Room Activity</h2>
          <p style="margin: 0 0 12px; color: #333;">
            <strong>${displayName}</strong> has joined the OfficeMal meeting room.
          </p>
          <p style="margin: 0 0 12px; color: #555; font-size: 14px;">
            Time: ${timestamp} UTC
          </p>
          <a
            href="${roomUrl}"
            style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #0070f3; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;"
          >
            Join Meeting
          </a>
        </div>
      `,
    });

    if (error) {
      console.error("[notify-meeting] Resend error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log("[notify-meeting] Email sent, id:", data?.id);
    return NextResponse.json({ success: true, emailId: data?.id });
  } catch (err) {
    console.error("[notify-meeting] Unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
