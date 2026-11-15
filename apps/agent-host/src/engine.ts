/** Engine boundary: no Telegram or HTTP concerns. */
export interface Engine {
  /** `onProgress` receives short, human-readable steps such as tool use. */
  run(
    prompt: string,
    onText: (text: string) => void,
    onProgress?: (message: string) => void,
  ): Promise<string>;
  stop(): Promise<void>;
}
