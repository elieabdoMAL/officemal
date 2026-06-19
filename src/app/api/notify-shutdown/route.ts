import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  // Optional: UptimeRobot sends a secret token we can verify
  const secret = req.headers.get("x-webhook-secret");
  if (process.env.SHUTDOWN_WEBHOOK_SECRET && secret !== process.env.SHUTDOWN_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    return NextResponse.json({ error: "ADMIN_EMAIL not set" }, { status: 500 });
  }

  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev",
    to: adminEmail,
    subject: "⚠️ OfficeMal kiosk went offline",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #fff8f0; border: 2px solid #f97316; border-radius: 12px;">
        <h2 style="margin: 0 0 16px; color: #c2410c;">⚠️ Kiosk Offline Alert</h2>
        <p style="margin: 0 0 12px; color: #333;">
          The OfficeMal reception kiosk has stopped responding. This usually means the computer lost power or internet.
        </p>
        <p style="margin: 0 0 12px; color: #555; font-size: 14px;">
          Last seen: <strong>${timestamp} UTC</strong>
        </p>
        <p style="color: #555; font-size: 14px;">
          The kiosk is configured to reboot automatically when power is restored. If it stays offline for more than a few minutes, check the kiosk PC physically.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("[notify-shutdown] Resend error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
