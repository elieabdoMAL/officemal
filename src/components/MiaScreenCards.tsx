"use client";

import { CONTACT, pick, type Bilingual, type Lang } from "@/lib/assistant";
import type { SentKind } from "@/lib/screenProtocol";

// Cards shown on the kiosk panel (#18): the contact card (Contact button, or
// the worker's "contact_card" message) and the "message sent" confirmation
// (the worker's "message_sent"). See docs/screen-protocol.md.
//
// Sizes are in vw, i.e. fractions of the Web Frame's own width (1280 CSS px in
// the tour, drawn ~0.7x on the 1080p kiosk), so they read the same whatever
// size the frame is published at.

export type Card =
  | { type: "contact_card"; lang: Lang | null }
  | { type: "message_sent"; kind: SentKind; to?: string; lang: Lang | null };

// The card sits to her left (the visitor's right), over the panorama, so it
// doesn't cover her face; it may overlap her shoulder.
const cardBox: React.CSSProperties = {
  position: "absolute",
  right: "2.5%",
  top: "50%",
  transform: "translateY(-55%)",
  width: "31%",
  boxSizing: "border-box",
  padding: "1.6vw 1.8vw",
  borderRadius: "1.2vw",
  background: "rgba(255,255,255,0.96)",
  color: "#14213d",
  boxShadow: "0 1vw 3vw rgba(0,0,0,0.35)",
  fontSize: "clamp(12px, 1.55vw, 26px)",
  lineHeight: 1.35,
  pointerEvents: "auto",
  textAlign: "left",
};

const L = {
  phone: { fr: "Téléphone", en: "Phone" },
  email: { fr: "Courriel", en: "Email" },
  address: { fr: "Adresse", en: "Address" },
  website: { fr: "Site web", en: "Website" },
  scan: { fr: "Balayez pour visiter notre site", en: "Scan to visit our website" },
  close: { fr: "Fermer", en: "Close" },
};

function label(lang: Lang | null, text: Bilingual) {
  return pick(lang, text).join(" · ");
}

function CloseButton({ lang, onClose }: { lang: Lang | null; onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-label={label(lang, L.close)}
      style={{
        position: "absolute",
        top: "0.6vw",
        right: "0.6vw",
        width: "3.4vw",
        height: "3.4vw",
        minWidth: 28,
        minHeight: 28,
        borderRadius: "50%",
        border: "none",
        background: "rgba(20,33,61,0.08)",
        color: "#14213d",
        fontSize: "clamp(14px, 1.8vw, 28px)",
        lineHeight: 1,
        cursor: "pointer",
      }}
    >
      ×
    </button>
  );
}

function ContactCard({ lang, onClose }: { lang: Lang | null; onClose: () => void }) {
  const row = (name: Bilingual, value: string) => (
    <div style={{ marginTop: "0.7vw" }}>
      <div
        style={{
          fontSize: "0.72em",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "#5b6b8c",
        }}
      >
        {label(lang, name)}
      </div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
  const address = lang ? CONTACT.address[lang] : CONTACT.address.fr;

  return (
    <div role="dialog" aria-label={CONTACT.company} style={cardBox}>
      <CloseButton lang={lang} onClose={onClose} />
      <div style={{ fontSize: "1.25em", fontWeight: 800, paddingRight: "3vw" }}>{CONTACT.company}</div>
      {row(L.phone, CONTACT.phone)}
      {row(L.email, CONTACT.email)}
      {row(L.address, address)}
      {row(L.website, CONTACT.website)}
      <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginTop: "1.1vw" }}>
        <img
          src={CONTACT.qr}
          alt={`QR: https://${CONTACT.website}`}
          style={{ width: "10vw", height: "10vw", minWidth: 72, minHeight: 72, borderRadius: "0.4vw" }}
        />
        <div style={{ fontSize: "0.8em", color: "#5b6b8c" }}>
          {pick(lang, L.scan).map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

const SENT: Record<SentKind, { to: (n: string) => Bilingual; plain: Bilingual }> = {
  message: {
    to: (n) => ({ fr: `Message envoyé à ${n}`, en: `Message sent to ${n}` }),
    plain: { fr: "Message envoyé", en: "Message sent" },
  },
  notify: {
    to: (n) => ({ fr: `Nous avons avisé ${n} de votre arrivée`, en: `${n} has been told you're here` }),
    plain: { fr: "Nous avons avisé l'équipe de votre arrivée", en: "The team has been told you're here" },
  },
  alert: {
    to: () => ({ fr: "L'équipe a été alertée", en: "The team has been alerted" }),
    plain: { fr: "L'équipe a été alertée", en: "The team has been alerted" },
  },
  suggestion: {
    to: () => ({ fr: "Suggestion envoyée — merci !", en: "Suggestion sent — thank you!" }),
    plain: { fr: "Suggestion envoyée — merci !", en: "Suggestion sent — thank you!" },
  },
  project_request: {
    to: () => ({ fr: "Demande de projet envoyée", en: "Project request sent" }),
    plain: { fr: "Demande de projet envoyée", en: "Project request sent" },
  },
};

function MessageSentCard({
  kind,
  to,
  lang,
  onClose,
}: {
  kind: SentKind;
  to?: string;
  lang: Lang | null;
  onClose: () => void;
}) {
  const text = to ? SENT[kind].to(to) : SENT[kind].plain;
  return (
    <div role="status" style={{ ...cardBox, display: "flex", alignItems: "center", gap: "1.2vw" }}>
      <CloseButton lang={lang} onClose={onClose} />
      <div
        aria-hidden
        style={{
          flex: "none",
          width: "4.4vw",
          height: "4.4vw",
          minWidth: 36,
          minHeight: 36,
          borderRadius: "50%",
          background: "#16a34a",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "clamp(18px, 2.6vw, 40px)",
          fontWeight: 800,
        }}
      >
        ✓
      </div>
      <div style={{ fontWeight: 700, fontSize: "1.1em", paddingRight: "2.5vw" }}>
        {pick(lang, text).map((t, i) => (
          <div key={t} style={i ? { fontWeight: 500, fontSize: "0.85em", marginTop: "0.3vw" } : undefined}>
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MiaScreenCard({ card, onClose }: { card: Card; onClose: () => void }) {
  if (card.type === "contact_card") return <ContactCard lang={card.lang} onClose={onClose} />;
  return <MessageSentCard kind={card.kind} to={card.to} lang={card.lang} onClose={onClose} />;
}

// Contact button, bottom right of the frame (the turn pill holds the middle).
export function ContactButton({ onClick, active }: { onClick: () => void; active: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        position: "absolute",
        right: "2.5%",
        bottom: "1.2vw",
        padding: "0.6vw 1.3vw",
        borderRadius: 999,
        border: "2px solid rgba(255,255,255,0.85)",
        background: active ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.55)",
        color: active ? "#14213d" : "white",
        fontSize: "clamp(12px, 1.5vw, 24px)",
        fontWeight: 700,
        cursor: "pointer",
        pointerEvents: "auto",
        boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
        fontFamily: "inherit",
      }}
    >
      ☎ Contact
    </button>
  );
}
