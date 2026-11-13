/**
 * Rewrite a public URL to a local one when the caller runs next to the service behind it
 * (the clearing service and the fleet on one machine, both published under one domain):
 * `routeUrl("https://site/agents/scout/a2a", [["https://site/agents/", "http://127.0.0.1:8788/agents/"]])`.
 */
export function routeUrl(url: string, routes: readonly (readonly [string, string])[] = []): string {
  for (const [from, to] of routes) if (from && url.startsWith(from)) return to + url.slice(from.length);
  return url;
}
