import { EventEmitter } from "events";
import { request } from "https";
import { CloudApiProvider } from "../providers/WhatsApp/Implementations/cloudApi";
import { handleMessage } from "../handlers/handleWhatsappEvents";

jest.mock("https", () => ({ request: jest.fn() }));
jest.mock("../models/Whatsapp", () => ({
  __esModule: true, default: { findByPk: jest.fn().mockResolvedValue({ status: "CONNECTED" }) }
}));
jest.mock("../libs/socket", () => ({ getIO: jest.fn() }));
jest.mock("../handlers/handleWhatsappEvents", () => ({ handleMessage: jest.fn() }));

beforeEach(() => {
  process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "123";
  process.env.WHATSAPP_CLOUD_API_VERSION = "v23.0";
  process.env.WHATSAPP_CLOUD_CONNECTION_ID = "7";
});

it("sends text to Graph API and persists its returned ID without waiting for an echo", async () => {
  const write = jest.fn();
  (request as jest.Mock).mockImplementation((_options, callback) => {
    const req = new EventEmitter() as any;
    req.setTimeout = jest.fn();
    req.write = write;
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      callback(res);
      res.emit("data", JSON.stringify({ messages: [{ id: "wamid.outbound" }] }));
      res.emit("end");
    };
    return req;
  });
  const message = await CloudApiProvider.sendMessage(7, "5511999999999@c.us", "Olá", { quotedMessageId: "wamid.inbound" });
  expect(message.id).toBe("wamid.outbound");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    hostname: "graph.facebook.com", path: "/v23.0/123/messages", method: "POST"
  }), expect.any(Function));
  expect(JSON.parse(write.mock.calls[0][0])).toEqual(expect.objectContaining({
    messaging_product: "whatsapp", to: "5511999999999", type: "text",
    text: { body: "Olá", preview_url: false }, context: { message_id: "wamid.inbound" }
  }));
  expect(handleMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "wamid.outbound", fromMe: true }),
    expect.any(Object), { whatsappId: 7, unreadMessages: 0 }, undefined, true
  );
});

it("rejects unconfigured connections and groups before making API requests", async () => {
  await expect(CloudApiProvider.sendMessage(8, "5511999999999@c.us", "Olá"))
    .rejects.toMatchObject({ message: "ERR_CLOUD_API_CONNECTION_NOT_CONFIGURED" });
  await expect(CloudApiProvider.sendMessage(7, "123@g.us", "Olá"))
    .rejects.toMatchObject({ message: "ERR_CLOUD_API_INVALID_MESSAGE" });
  expect(request).not.toHaveBeenCalled();
});

it("returns API error codes without exposing the Meta error message or credentials", async () => {
  (request as jest.Mock).mockImplementation((_options, callback) => {
    const req = new EventEmitter() as any;
    req.setTimeout = jest.fn();
    req.write = jest.fn();
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 400;
      callback(res);
      res.emit("data", JSON.stringify({ error: { code: 131047, message: "sensitive details" } }));
      res.emit("end");
    };
    return req;
  });
  await expect(CloudApiProvider.sendMessage(7, "5511999999999", "Olá"))
    .rejects.toMatchObject({ message: "ERR_CLOUD_API_131047" });
  expect(handleMessage).not.toHaveBeenCalled();
});
