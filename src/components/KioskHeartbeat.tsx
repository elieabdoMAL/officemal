"use client";

import { useEffect } from "react";

const PING_INTERVAL_MS = 55_000;
const BASE_URL = "https://hc-ping.com/808e7ae5-d1e1-4c80-a7f7-52108e160d71";

export default function KioskHeartbeat() {
  useEffect(() => {
    // Read ?kiosk=<name> from the URL so each location self-identifies.
    // e.g. https://officemal.vercel.app?kiosk=reception-dubai
    const params = new URLSearchParams(window.location.search);
    const kioskId = params.get("kiosk");
    const url = kioskId ? `${BASE_URL}?rid=${encodeURIComponent(kioskId)}` : BASE_URL;

    const ping = () => {
      fetch(url, { method: "GET", mode: "no-cors", cache: "no-store" }).catch(() => {});
    };

    ping();
    const id = setInterval(ping, PING_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
