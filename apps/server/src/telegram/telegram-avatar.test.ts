import { InputFile, type Api } from "grammy";
import { expect, it, vi } from "vitest";
import { syncTelegramAvatar } from "./telegram-avatar.js";

function fixture() {
  const bytes = Buffer.from("image");
  const api = {
    getUserProfilePhotos: vi.fn<Api["getUserProfilePhotos"]>(),
    setMyProfilePhoto: vi
      .fn<Api["setMyProfilePhoto"]>()
      .mockResolvedValue(true),
  };
  const controller = new AbortController();
  return {
    api,
    controller,
    sync: () =>
      syncTelegramAvatar(
        api,
        123,
        async () => bytes,
        () => !controller.signal.aborted,
        controller.signal,
      ),
  };
}

it("sets a static JPG on the verified bot when its profile has no photos", async () => {
  const { api, sync } = fixture();
  api.getUserProfilePhotos.mockResolvedValue({ total_count: 0, photos: [] });
  await sync();
  expect(api.getUserProfilePhotos).toHaveBeenCalledWith(
    123,
    { limit: 1 },
    expect.anything(),
  );
  expect(api.setMyProfilePhoto).toHaveBeenCalledExactlyOnceWith(
    { type: "static", photo: expect.any(InputFile) },
    expect.anything(),
  );
  const photo = api.setMyProfilePhoto.mock.calls[0]?.[0];
  expect(photo?.type === "static" && photo.photo.filename).toBe("avatar.jpg");
});

it("preserves existing photos and skips uploads after a failed lookup or disconnected bot", async () => {
  const { api, controller, sync } = fixture();
  api.getUserProfilePhotos
    .mockResolvedValueOnce({ total_count: 1, photos: [] })
    .mockRejectedValueOnce(new Error("lookup failed"))
    .mockImplementationOnce(async () => {
      controller.abort();
      return { total_count: 0, photos: [] };
    });
  await sync();
  await expect(sync()).rejects.toThrow("lookup failed");
  await sync();
  expect(api.setMyProfilePhoto).not.toHaveBeenCalled();
});

it("replaces an existing profile photo when forced", async () => {
  const { api, controller } = fixture();
  await syncTelegramAvatar(
    api,
    123,
    async () => Buffer.from("image"),
    () => true,
    controller.signal,
    true,
  );
  expect(api.getUserProfilePhotos).not.toHaveBeenCalled();
  expect(api.setMyProfilePhoto).toHaveBeenCalledOnce();
});
