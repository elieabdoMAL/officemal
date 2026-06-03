import "./embed.css";

// Wraps the embedded receptionist with a transparent body so the chroma-keyed
// canvas shows through to whatever sits behind the 3DVista Web Frame hotspot.
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
