/**
 * Minimal ambient declaration for `qrcode-terminal` (no bundled types).
 * Only the surface this plugin uses is declared.
 */
declare module 'qrcode-terminal' {
  export function generate(
    text: string,
    opts: { small?: boolean },
    callback: (qrcode: string) => void,
  ): void
  const _default: { generate: typeof generate }
  export default _default
}
