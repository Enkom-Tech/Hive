/** OCI image reference must end with a sha256 content digest (immutable pin). */
const DIGEST_PINNED_SUFFIX = /@sha256:[a-fA-F0-9]{64}$/;

export function isDigestPinnedImageRef(ref: string): boolean {
  const s = ref.trim();
  if (!s) return false;
  return DIGEST_PINNED_SUFFIX.test(s);
}
