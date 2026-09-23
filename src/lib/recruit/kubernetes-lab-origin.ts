/** Compare against the configured public site, never caller-supplied proxy headers. */
export function labRequestOriginAllowed(
  origin: string | null,
  requestOrigin: string,
  configuredOrigin: string | undefined = process.env.NEXTAUTH_URL,
): boolean {
  if (origin === null) return true; // Authenticated non-browser requests.
  try {
    const expected = new URL(configuredOrigin || requestOrigin);
    if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password
      || expected.pathname !== "/" || expected.search || expected.hash) return false;
    return origin === expected.origin;
  } catch { return false; }
}
