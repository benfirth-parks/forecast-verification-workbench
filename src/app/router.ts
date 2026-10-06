import { useEffect, useState } from "react";

/** Hash routes: "#/case/<id>?a=b". Query string holds filter state so it survives reloads and links. */
export function useRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, "") || "/today-review";
    const [path, query = ""] = raw.split("?");
    return { path, query: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(path: string, query?: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v) as [string, string][]).toString();
  window.location.hash = q ? `${path}?${q}` : path;
}
