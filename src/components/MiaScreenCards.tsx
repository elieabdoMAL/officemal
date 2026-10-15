"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ASSISTANT_NAME, CONTACT, pick, type Bilingual, type Lang } from "@/lib/assistant";
import { LAYOUT } from "@/lib/screenLayout";
import type { ProjectFields, ProjectStatus, SentKind } from "@/lib/screenProtocol";

// Cards shown on the kiosk panel (#18): the contact card (Contact button, or
// the worker's "contact_card" message), the "message sent" confirmation (the
// worker's "message_sent"), the project request form (#20, the worker's
// "project_request"), the directions card (#7, the worker's "directions").
// See docs/screen-protocol.md. A video call to staff (#22) opens its own
// window on the top page (StaffCallModal), not a card.
//
// Sizes are in vw, i.e. fractions of the Web Frame's own width (1280 CSS px in
// the tour, drawn ~0.7x on the 1080p kiosk), so they read the same whatever
// size the frame is published at. Positions and widths come from
// src/lib/screenLayout.ts — the one place to tune them.

export type Card =
  | { type: "contact_card"; lang: Lang | null }
  | { type: "message_sent"; kind: SentKind; to?: string; lang: Lang | null }
  | { type: "project_request"; status: ProjectStatus; fields: ProjectFields; lang: Lang | null }
  | { type: "directions"; address: string; maps_url: string; lang: Lang | null }
  | { type: "recording"; lang: Lang | null };

// The card sits to her left (the visitor's right), over the panorama, so it
// doesn't cover her face; it may overlap her shoulder.
const cardBox: React.CSSProperties = {
  position: "absolute",
  right: LAYOUT.card.right,
  top: LAYOUT.card.top,
  transform: `translateY(${LAYOUT.card.translateY})`,
  width: LAYOUT.card.width,
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
  directions: { fr: "Itinéraire", en: "Directions" },
  scanDirections: { fr: "Scannez pour l'itinéraire", en: "Scan for directions" },
  close: { fr: "Fermer", en: "Close" },
};

function label(lang: Lang | null, text: Bilingual) {
  // "Budget · Budget" reads as a glitch: same word in both, say it once.
  return [...new Set(pick(lang, text))].join(" · ");
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

// The directions card's QR (#7), generated in the browser from the maps URL
// the worker sent — no external QR service at runtime, so the request never
// leaves the kiosk. ~0.5 KB of canvas work, done once per card.
function useQrDataUrl(text: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 512 })
      .then((u) => {
        if (!stale) setUrl(u);
      })
      .catch((e) => console.warn("[MiaScreenCards] QR generation failed:", e));
    return () => {
      stale = true;
    };
  }, [text]);
  return url;
}

// #7: the office address and a QR straight to Google Maps directions. Same
// box as the contact card; closes after 45 s or on ×.
function DirectionsCard({
  address,
  mapsUrl,
  lang,
  onClose,
}: {
  address: string;
  mapsUrl: string;
  lang: Lang | null;
  onClose: () => void;
}) {
  const qr = useQrDataUrl(mapsUrl);
  return (
    <div role="dialog" aria-label={label(lang, L.directions)} data-card="directions" style={cardBox}>
      <CloseButton lang={lang} onClose={onClose} />
      <div style={{ fontSize: "1.25em", fontWeight: 800, paddingRight: "3vw" }}>
        <span aria-hidden>📍 </span>
        {label(lang, L.directions)}
      </div>
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
          {label(lang, L.address)}
        </div>
        <div style={{ fontWeight: 600 }}>{address}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "1.2vw", marginTop: "1.1vw" }}>
        {qr && (
          <img
            src={qr}
            alt={`QR: ${mapsUrl}`}
            style={{ width: "12vw", height: "12vw", minWidth: 88, minHeight: 88, borderRadius: "0.4vw" }}
          />
        )}
        <div style={{ fontSize: "0.9em", fontWeight: 600, color: "#14213d" }}>
          {pick(lang, L.scanDirections).map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// A voice message is being recorded (#5, round 2): a red pulsing dot and how
// to finish. No ×: it is a state, not content — the worker takes it down when
// the recording stops.
const RECORDING_TEXT = {
  title: { fr: "Enregistrement", en: "Recording" },
  hint: {
    fr: "Dites « c'est tout » quand vous avez terminé",
    en: "Say “done” when you're finished",
  },
};

function RecordingCard({ lang }: { lang: Lang | null }) {
  return (
    <div
      role="status"
      data-card="recording"
      style={{ ...cardBox, display: "flex", alignItems: "center", gap: "1.2vw", borderTop: "0.45vw solid #dc2626" }}
    >
      <style>{"@keyframes miaRecPulse{0%,100%{opacity:1}50%{opacity:0.25}}"}</style>
      <div
        aria-hidden
        style={{
          flex: "none",
          width: "2.6vw",
          height: "2.6vw",
          minWidth: 22,
          minHeight: 22,
          borderRadius: "50%",
          background: "#dc2626",
          animation: "miaRecPulse 1.6s ease-in-out infinite",
        }}
      />
      <div>
        <div style={{ fontWeight: 800, fontSize: "1.15em", color: "#b91c1c" }}>{label(lang, RECORDING_TEXT.title)}</div>
        <div style={{ fontWeight: 600, fontSize: "0.9em", marginTop: "0.3vw" }}>
          {pick(lang, RECORDING_TEXT.hint).map((t) => (
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
  // `to` is "{who} · {when}", already in her language (worker's book_meeting).
  meeting: {
    to: (n) => ({ fr: `Rendez-vous réservé : ${n}`, en: `Meeting booked: ${n}` }),
    plain: { fr: "Rendez-vous réservé", en: "Meeting booked" },
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

// Labels for the worker's PROJECT_FIELDS (agent-worker/leads.py). A field the
// worker adds later still shows, under its key, until it gets a label here.
const PROJECT_LABEL: Record<string, Bilingual> = {
  name: { fr: "Nom", en: "Name" },
  company: { fr: "Entreprise", en: "Company" },
  email: { fr: "Courriel", en: "Email" },
  phone: { fr: "Téléphone", en: "Phone" },
  description: { fr: "Projet", en: "Project" },
  timeline: { fr: "Échéancier", en: "Timeline" },
  budget: { fr: "Budget", en: "Budget" },
};

const PROJECT_TEXT = {
  draftTitle: { fr: "Votre demande de projet", en: "Your project request" },
  draftHint: {
    fr: `Vérifiez-la et dites à ${ASSISTANT_NAME} quoi corriger`,
    en: `Please check it and tell ${ASSISTANT_NAME} what to change`,
  },
  sentTitle: { fr: "Demande de projet envoyée", en: "Project request sent" },
  sentHint: { fr: "L'équipe vous reviendra", en: "The team will get back to you" },
};

function projectLabel(key: string): Bilingual {
  const plain = key.replace(/_/g, " ");
  return PROJECT_LABEL[key] ?? { fr: plain, en: plain };
}

function ProjectRequestCard({
  status,
  fields,
  lang,
  onClose,
}: {
  status: ProjectStatus;
  fields: ProjectFields;
  lang: Lang | null;
  onClose: () => void;
}) {
  const sent = status === "sent";
  // The draft shows every field, so the visitor sees what's still blank; the
  // sent card only what went out.
  const rows = sent ? fields.filter(([, v]) => v) : fields;
  const title = pick(lang, sent ? PROJECT_TEXT.sentTitle : PROJECT_TEXT.draftTitle);
  const hint = pick(lang, sent ? PROJECT_TEXT.sentHint : PROJECT_TEXT.draftHint);

  return (
    <div
      role={sent ? "status" : "dialog"}
      aria-label={title[0]}
      data-project-status={status}
      style={{
        ...cardBox,
        width: LAYOUT.card.projectWidth,
        fontSize: "clamp(11px, 1.35vw, 22px)",
        borderTop: `0.45vw solid ${sent ? "#16a34a" : "#f59e0b"}`,
      }}
    >
      <CloseButton lang={lang} onClose={onClose} />
      <div style={{ display: "flex", alignItems: "center", gap: "0.9vw", paddingRight: "3vw" }}>
        {sent && (
          <div
            aria-hidden
            style={{
              flex: "none",
              width: "3vw",
              height: "3vw",
              minWidth: 26,
              minHeight: 26,
              borderRadius: "50%",
              background: "#16a34a",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
            }}
          >
            ✓
          </div>
        )}
        <div style={{ fontSize: "1.2em", fontWeight: 800, lineHeight: 1.2 }}>
          {title.map((t, i) => (
            <div key={t} style={i ? { fontSize: "0.75em", fontWeight: 600, color: "#5b6b8c" } : undefined}>
              {t}
            </div>
          ))}
        </div>
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          columnGap: "1.2vw",
          rowGap: "0.45vw",
          margin: "1vw 0 0",
        }}
      >
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt
              style={{
                fontSize: "0.72em",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#5b6b8c",
                paddingTop: "0.25em",
                whiteSpace: "nowrap",
              }}
            >
              {label(lang, projectLabel(key))}
            </dt>
            <dd
              style={{
                margin: 0,
                fontWeight: value ? 600 : 400,
                color: value ? "#14213d" : "#9aa5bd",
                overflowWrap: "anywhere",
                // A long description shouldn't push the card off the frame.
                display: "-webkit-box",
                WebkitLineClamp: key === "description" ? 4 : 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {value || "—"}
            </dd>
          </div>
        ))}
      </dl>
      <div
        style={{
          marginTop: "1vw",
          paddingTop: "0.7vw",
          borderTop: "1px solid rgba(20,33,61,0.12)",
          fontSize: "0.85em",
          fontWeight: 600,
          color: sent ? "#15803d" : "#b45309",
        }}
      >
        {hint.map((t) => (
          <div key={t}>{t}</div>
        ))}
      </div>
    </div>
  );
}

export default function MiaScreenCard({ card, onClose }: { card: Card; onClose: () => void }) {
  if (card.type === "contact_card") return <ContactCard lang={card.lang} onClose={onClose} />;
  if (card.type === "project_request")
    return <ProjectRequestCard status={card.status} fields={card.fields} lang={card.lang} onClose={onClose} />;
  if (card.type === "directions")
    return <DirectionsCard address={card.address} mapsUrl={card.maps_url} lang={card.lang} onClose={onClose} />;
  if (card.type === "recording") return <RecordingCard lang={card.lang} />;
  return <MessageSentCard kind={card.kind} to={card.to} lang={card.lang} onClose={onClose} />;
}

// Contact button. Where it sits is LAYOUT.contactButton (top OR bottom).
export function ContactButton({ onClick, active }: { onClick: () => void; active: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        position: "absolute",
        right: LAYOUT.contactButton.right,
        top: LAYOUT.contactButton.top,
        bottom: LAYOUT.contactButton.bottom,
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
