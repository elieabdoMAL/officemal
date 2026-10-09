"use client";

import type { RefObject } from "react";
import { pick, type Lang } from "@/lib/assistant";

// A team member she called in by video (#22), on the kiosk: their camera in
// a large tile to the right of her (she steps aside and stays quiet), with
// "{first name} is here". The <video> stays mounted, hidden, so the panel can
// attach their track the moment it arrives; it shows once they've joined.
// Their voice plays through the panel's own staff <audio>.

const TEXT = {
  here: (first: string) => ({ fr: `${first} est là`, en: `${first} is here` }),
  sub: { fr: "En appel vidéo avec vous", en: "On a video call with you" },
};

export default function MiaStaffTile({
  name,
  hasVideo,
  lang,
  videoRef,
}: {
  // Their display name ("Nicolas Bastien"); null when nobody from the team is in the call.
  name: string | null;
  hasVideo: boolean;
  lang: Lang | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const first = name?.split(/\s+/)[0] ?? "";
  const initials = (name ?? "")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      data-staff-tile={name ? "on" : "off"}
      aria-hidden={!name}
      style={{
        position: "absolute",
        right: "3%",
        top: "4%",
        height: "84%",
        aspectRatio: "3 / 4",
        maxWidth: "52%",
        borderRadius: "1.4vw",
        overflow: "hidden",
        background: "#14213d",
        border: "0.3vw solid rgba(255,255,255,0.9)",
        boxShadow: "0 1.2vw 4vw rgba(0,0,0,0.45)",
        display: name ? "block" : "none",
        pointerEvents: "none",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted // their voice plays through the panel's staff <audio>
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: hasVideo ? "block" : "none",
        }}
      />
      {!hasVideo && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "clamp(28px, 7vw, 120px)",
            fontWeight: 800,
            color: "rgba(255,255,255,0.9)",
          }}
        >
          {initials}
        </div>
      )}
      <div
        role="status"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "2.6vw 1.4vw 1.1vw",
          background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
          color: "white",
          textShadow: "0 2px 8px rgba(0,0,0,0.8)",
        }}
      >
        {pick(lang, TEXT.here(first)).map((t, i) => (
          <div
            key={t}
            style={{
              fontSize: i ? "clamp(12px, 1.5vw, 24px)" : "clamp(16px, 2.4vw, 40px)",
              fontWeight: i ? 600 : 800,
            }}
          >
            {i === 0 && (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: "0.55em",
                  height: "0.55em",
                  borderRadius: "50%",
                  background: "#22c55e",
                  marginRight: "0.35em",
                  verticalAlign: "middle",
                }}
              />
            )}
            {t}
          </div>
        ))}
        <div style={{ fontSize: "clamp(11px, 1.3vw, 20px)", opacity: 0.85, marginTop: "0.2vw" }}>
          {pick(lang, TEXT.sub).join(" · ")}
        </div>
      </div>
    </div>
  );
}
