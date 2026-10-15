import { Router } from "express";
import Message from "../models/Message";
import Whatsapp from "../models/Whatsapp";
import { handleMessage, handleMessageAck } from "../handlers/handleWhatsappEvents";
import { validCloudSignature } from "../helpers/CloudWebhookSignature";
import { cloudConfig } from "../providers/WhatsApp/Implementations/cloudApi";
import { MessageAck } from "../providers/WhatsApp/types";
import AppError from "../errors/AppError";

const router = Router();
// Serialize webhook work to avoid duplicate tickets on concurrent Meta retries.
// This first version is intended for one backend replica.
let pending: Promise<unknown> = Promise.resolve();

router.get("/", (req, res) => {
  const token = process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
  if (process.env.WHATSAPP_PROVIDER !== "cloudapi" || !token) return res.sendStatus(503);
  if (req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== token ||
      typeof req.query["hub.challenge"] !== "string") return res.sendStatus(403);
  return res.status(200).type("text/plain").send(req.query["hub.challenge"]);
});

router.post("/", async (req, res) => {
  const secret = process.env.WHATSAPP_CLOUD_APP_SECRET;
  if (process.env.WHATSAPP_PROVIDER !== "cloudapi" || !secret) return res.sendStatus(503);
  if (!Buffer.isBuffer(req.body) || !validCloudSignature(
    req.body, req.get("x-hub-signature-256"), secret
  )) return res.sendStatus(401);
  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); }
  catch (_) { return res.sendStatus(400); }
  if (!payload || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
    return res.sendStatus(400);
  }
  const config = cloudConfig();
  const processEvent = async () => {
    const whatsapp = await Whatsapp.findByPk(config.sessionId);
    if (!whatsapp || whatsapp.status !== "CONNECTED") throw new AppError("ERR_CLOUD_API_CONNECTION_UNAVAILABLE", 503);
    for (const entry of payload.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (change.field !== "messages" || value?.metadata?.phone_number_id !== config.phoneId) continue;
        for (const message of value.messages || []) {
          if (!message.id || !/^\d{7,15}$/.test(message.from || "")) continue;
          if (await Message.findByPk(message.id)) continue;
          const name = value.contacts?.find((contact: any) => contact.wa_id === message.from)?.profile?.name;
          // Preserve a visible placeholder for types not implemented in this first milestone.
          const body = message.type === "text" && typeof message.text?.body === "string"
            ? message.text.body : `[Cloud API: mensagem ${message.type || "desconhecida"} ainda não suportada]`;
          await handleMessage({
            id: message.id, body, fromMe: false, hasMedia: false, type: "chat",
            timestamp: Number(message.timestamp), from: message.from, to: config.phoneId,
            quotedMsgId: message.context?.id, hasQuotedMsg: Boolean(message.context?.id)
          }, { name: name || message.from, number: message.from, isGroup: false },
          { whatsappId: config.sessionId, unreadMessages: 1 }, undefined, true);
          if (!await Message.findByPk(message.id)) {
            throw new AppError("ERR_CLOUD_API_MESSAGE_NOT_PERSISTED", 503);
          }
        }
        const acks: Record<string, MessageAck> = { sent: 1, delivered: 2, read: 3, failed: 0 };
        for (const status of value.statuses || []) {
          const stored = await Message.findByPk(status.id);
          if (stored?.fromMe && acks[status.status] !== undefined) {
            // Do not regress read/delivered when events arrive out of order.
            if (acks[status.status] >= stored.ack) await handleMessageAck(status.id, acks[status.status]);
          }
        }
      }
    }
  };
  const work = pending.then(processEvent);
  pending = work.catch(() => undefined);
  await work;
  return res.sendStatus(200);
});

export default router;
