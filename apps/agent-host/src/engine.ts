/** Engine boundary: no Telegram or HTTP concerns. */
export interface Engine {
  /**
   * `onProgress` receives short, human-readable steps such as tool use.
   * `requestApproval` asks a person to allow one sensitive action described by
   * `title`; without it, or on any failure, the action is denied.
   */
  run(
    prompt: string,
    onText: (text: string) => void,
    onProgress?: (message: string) => void,
    requestApproval?: (title: string) => Promise<boolean>,
  ): Promise<string>;
  stop(): Promise<void>;
}
