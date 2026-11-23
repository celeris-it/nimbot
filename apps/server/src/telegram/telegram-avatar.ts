import { InputFile, type Api } from "grammy";

export async function syncTelegramAvatar(
  api: Pick<Api, "getUserProfilePhotos" | "setMyProfilePhoto">,
  botId: number,
  load: () => Promise<Buffer | undefined>,
  isCurrent: () => boolean,
  connectionSignal: AbortSignal,
) {
  const bytes = await load();
  if (!bytes || !isCurrent()) return;
  const signal = AbortSignal.any([
    connectionSignal,
    AbortSignal.timeout(5000),
  ]) as unknown as Parameters<Api["setMyProfilePhoto"]>[1];
  const photos = await api.getUserProfilePhotos(botId, { limit: 1 }, signal);
  if (photos.total_count !== 0 || !isCurrent()) return;
  await api.setMyProfilePhoto(
    { type: "static", photo: new InputFile(bytes, "avatar.jpg") },
    signal,
  );
}
