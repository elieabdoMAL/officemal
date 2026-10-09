// Who the receptionist is on screen, in one place. The name is a build-time
// setting so a rename (the boss's notes call her "Linda") is one env change:
// NEXT_PUBLIC_ASSISTANT_NAME, default "Mia". NEXT_PUBLIC_ values are inlined
// by `next build`, so changing it needs a rebuild. Her spoken name lives in the
// worker's prompt, which must be changed to match.
export const ASSISTANT_NAME = process.env.NEXT_PUBLIC_ASSISTANT_NAME?.trim() || "Mia";

export type Lang = "fr" | "en";

// The language she is speaking, as the worker reports it ("mia.language", see
// docs/screen-protocol.md). null until it does: screens then show both.
export function asLang(v: unknown): Lang | null {
  if (typeof v !== "string") return null;
  const l = v.trim().toLowerCase();
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("en")) return "en";
  return null;
}

export type Bilingual = { fr: string; en: string };

// Text in her language, or both (French first, it's a Québec lobby) when the
// language isn't known yet.
export function pick(lang: Lang | null, text: Bilingual): string[] {
  return lang ? [text[lang]] : [text.fr, text.en];
}

// Same facts as the CONTACT section of agent-worker/mia_prompt.txt — change
// both together.
export const CONTACT = {
  company: "Mobile Apps Labs",
  phone: "1 514 573 2324",
  email: "info@mobileappslabs.com",
  address: {
    fr: "74, rue Turgeon, Sainte-Thérèse (Québec)",
    en: "74 Turgeon Street, Sainte-Thérèse, Quebec",
  },
  website: "mobileappslabs.com",
  // QR code for https://mobileappslabs.com (public/mia/qr-website.svg). Made
  // once with `npx qrcode -t svg -e M -o qr-website.svg https://mobileappslabs.com`;
  // regenerate it if the website changes.
  qr: "/mia/qr-website.svg",
};
