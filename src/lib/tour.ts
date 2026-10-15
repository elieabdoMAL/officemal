// Reaching into the published 3DVista tour from the Next.js page. The tour runs
// in a same-origin iframe (/3dvista/index.html), so its player object can be
// driven directly. Shared by AiToggle (AI button), MiaVr (Mia in VR) and
// StaffCallModal (video call to staff).

// Any 3DVista player object: overlays, resources, levels…
export type TDVObject = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

type Player = { getByClassName?: (cls: string) => TDVObject[] };

export function tourFrame(): HTMLIFrameElement | null {
  return document.querySelector('iframe[src*="3dvista"]');
}

// `var tour` is a global inside the published tour (script.js line 5); the
// player hangs off it once TDV.Tour has initialized.
export function getPlayer(): Player | null {
  try {
    const win = tourFrame()?.contentWindow as unknown as {
      tour?: { player?: unknown; _player?: unknown };
      rootPlayer?: unknown;
    } | null;
    if (!win) return null;
    return (win.tour?.player ?? win.tour?._player ?? win.rootPlayer ?? null) as Player | null;
  } catch {
    return null; // cross-origin — callers fall back or give up
  }
}

// 3DVista generates opaque ids (overlay_A9B5493B_...), so the editor name is the
// only handle worth coding against. It lives on the object's `data` bag — as
// `label` for panorama overlays, `name` for skin components.
export function findByLabel(classes: string[], label: string): TDVObject | null {
  const player = getPlayer();
  if (!player?.getByClassName) return null;

  for (const cls of classes) {
    let items: TDVObject[] = [];
    try {
      items = player.getByClassName(cls) || [];
    } catch {
      continue;
    }
    for (const item of items) {
      const data = item.get?.("data") as { name?: string; label?: string } | undefined;
      if (data?.label === label || data?.name === label) return item;
    }
  }
  return null;
}

// Post to the receptionist embed: to the tour, and straight to the iframes
// inside it (same-origin) so we don't depend on the tour forwarding it. With no
// tour (the embed page opened on its own, for tests) the embed is this window.
export function postToEmbed(messages: object[]) {
  const send = (win: Window | null) => {
    if (!win) return;
    try {
      messages.forEach((m) => win.postMessage(m, "*"));
    } catch {}
  };
  const frame = tourFrame();
  if (!frame) {
    send(window);
    return;
  }
  send(frame.contentWindow);
  try {
    frame.contentDocument
      ?.querySelectorAll<HTMLIFrameElement>("iframe")
      .forEach((f) => send(f.contentWindow));
  } catch {}
}
