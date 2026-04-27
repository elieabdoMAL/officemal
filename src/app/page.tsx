"use client";

import MeetingModal from "@/components/MeetingModal";
import PasscodeModal from "@/components/PasscodeModal";
import InfiniViewModal from "@/components/InfiniViewModal";

export default function Page() {
  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <iframe
        src="/3dvista/index.html"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: "none",
        }}
        allow="vr; gyroscope; accelerometer; autoplay"
      />
      <MeetingModal />
      <PasscodeModal />
      <InfiniViewModal />
    </div>
  );
}
