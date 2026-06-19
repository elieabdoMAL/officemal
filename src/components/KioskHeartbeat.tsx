"use client";

import { useEffect } from "react";

const PING_INTERVAL_MS = 55_000;

export default function KioskHeartbeat() {
  useEffect(() => {
    const ping = () => {
      fetch("https://hc-ping.com/808e7ae5-d1e1-4c80-a7f7-52108e160d71", { method: "GET", mode: "no-cors", cache: "no-store" }).catch(() => {});
    };

    ping();
    const id = setInterval(ping, PING_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
