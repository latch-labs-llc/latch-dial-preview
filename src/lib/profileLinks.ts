/**
 * Shareable profile links (v0.5 #3). /u/<handle> always means a Latch
 * @handle, and every action from the profile goes through the NAME, so the
 * pin-on-first-use check runs in Pay and Add contact.
 */
export const profilePath = (handle: string) => `/u/${encodeURIComponent(handle.replace(/^@/, "").toLowerCase())}`;

/** The route segment after /u/ → the name to resolve ("@sam"). */
export const nameFromProfilePath = (segment: string) => `@${decodeURIComponent(segment).replace(/^@/, "").toLowerCase()}`;

export const payHrefForName = (name: string) => `/pay?to=${encodeURIComponent(name)}&src=link`;
export const contactHrefForName = (name: string) => `/contact/new?address=${encodeURIComponent(name)}`;
