"use client";

import MeetingModal from "@/components/MeetingModal";
import PasscodeModal from "@/components/PasscodeModal";
import InfiniViewModal from "@/components/InfiniViewModal";
import MalModal from "@/components/MalModal";
import Controls from "@/components/Controls";
import Receptionist from "@/components/Receptionist";
import KioskLock from "@/components/KioskLock";

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
      <MalModal />
      <Controls />
      <Receptionist />
      <KioskLock />
    </div>
  );
}
