/** Engine boundary: no Telegram or HTTP concerns. */
export interface Engine {
  run(prompt: string, onText: (text: string) => void): Promise<string>;
  stop(): Promise<void>;
}
