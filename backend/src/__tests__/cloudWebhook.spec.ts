import "express-async-errors";
import express from "express";
import request from "supertest";
import { createHmac } from "crypto";
import router from "../routes/cloudWebhookRoutes";
import Message from "../models/Message";
import { handleMessage, handleMessageAck } from "../handlers/handleWhatsappEvents";

jest.mock("../models/Message", () => ({ __esModule: true, default: { findByPk: jest.fn() } }));
jest.mock("../models/Whatsapp", () => ({
  __esModule: true, default: { findByPk: jest.fn().mockResolvedValue({ status: "CONNECTED" }) }
}));
jest.mock("../handlers/handleWhatsappEvents", () => ({
  handleMessage: jest.fn(), handleMessageAck: jest.fn()
}));
jest.mock("../providers/WhatsApp/Implementations/cloudApi", () => ({
  cloudConfig: () => ({ phoneId: "123", sessionId: 7 })
}));

const app = express();
app.use("/webhooks/whatsapp", express.raw({ type: "application/json" }), router);
app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.sendStatus(503);
});

const event = (value: object) => JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "123" }, ...value } }] }]
});
const post = (body: string, signature?: string) => request(app)
  .post("/webhooks/whatsapp").set("Content-Type", "application/json")
  .set("x-hub-signature-256", signature || `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`)
  .send(body);

beforeEach(() => {
  process.env.WHATSAPP_PROVIDER = "cloudapi";
  process.env.WHATSAPP_CLOUD_APP_SECRET = "test-secret";
  process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = "verify-me";
  (Message.findByPk as jest.Mock).mockReset();
  (handleMessage as jest.Mock).mockReset();
});

it("verifies Meta subscription and rejects a wrong verify token", async () => {
  await request(app).get("/webhooks/whatsapp").query({
    "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1234"
  }).expect(200, "1234");
  await request(app).get("/webhooks/whatsapp").query({
    "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1234"
  }).expect(403);
});

it("rejects forged signatures before processing data", async () => {
  await post(event({}), `sha256=${"0".repeat(64)}`).expect(401);
  expect(handleMessage).not.toHaveBeenCalled();
});

it("persists incoming text and skips an already persisted retry", async () => {
  const body = event({ messages: [{ id: "wamid.test", from: "5511999999999", timestamp: "1700000000", type: "text", text: { body: "Olá" } }] });
  (Message.findByPk as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue({ id: "wamid.test" });
  await post(body).expect(200);
  await post(body).expect(200);
  expect(handleMessage).toHaveBeenCalledTimes(1);
  expect(handleMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "wamid.test", body: "Olá", fromMe: false }),
    expect.objectContaining({ number: "5511999999999" }),
    { whatsappId: 7, unreadMessages: 1 }, undefined, true
  );
});

it("does not acknowledge lost messages so Meta can retry", async () => {
  (Message.findByPk as jest.Mock).mockResolvedValue(null);
  const body = event({ messages: [{ id: "lost", from: "5511999999999", type: "text", text: { body: "retry" } }] });
  await post(body).expect(503);
  (Message.findByPk as jest.Mock).mockResolvedValue({ id: "lost" });
  await post(body).expect(200);
});

it("ignores another phone number and does not regress read receipts", async () => {
  await post(event({ metadata: { phone_number_id: "another" }, messages: [{ id: "foreign" }] })).expect(200);
  expect(handleMessage).not.toHaveBeenCalled();
  (Message.findByPk as jest.Mock).mockResolvedValue({ fromMe: true, ack: 3 });
  await post(event({ statuses: [{ id: "read", status: "delivered" }] })).expect(200);
  expect(handleMessageAck).not.toHaveBeenCalled();
});
