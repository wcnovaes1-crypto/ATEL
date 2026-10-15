import { request } from "https";
import Whatsapp from "../../../models/Whatsapp";
import AppError from "../../../errors/AppError";
import { getIO } from "../../../libs/socket";
import { handleMessage } from "../../../handlers/handleWhatsappEvents";
import { WhatsappProvider } from "../whatsappProvider";

export const cloudConfig = () => {
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_CLOUD_API_VERSION;
  const sessionId = Number(process.env.WHATSAPP_CLOUD_CONNECTION_ID);
  if (!token || !phoneId || !version || !/^\d+$/.test(phoneId) || !/^v\d+\.\d+$/.test(version) ||
      !Number.isSafeInteger(sessionId) || sessionId < 1) {
    throw new AppError("ERR_CLOUD_API_CONFIGURATION", 503);
  }
  return { token, phoneId, version, sessionId };
};

const checkSession = (sessionId: number) => {
  const config = cloudConfig();
  if (sessionId !== config.sessionId) {
    throw new AppError("ERR_CLOUD_API_CONNECTION_NOT_CONFIGURED", 400);
  }
  return config;
};

export const cloudRequest = (path: string, body?: object): Promise<any> => {
  const config = cloudConfig();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = request({
      hostname: "graph.facebook.com",
      path: `/${config.version}/${path}`,
      method: data ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, res => {
      let response = "";
      res.on("data", chunk => { response += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(response);
          if (!res.statusCode || res.statusCode >= 400 || parsed.error) {
            // Never expose access tokens or request/response payloads in logs.
            reject(new AppError(`ERR_CLOUD_API_${parsed.error?.code || res.statusCode}`, 502));
          } else resolve(parsed);
        } catch (_) {
          reject(new AppError("ERR_CLOUD_API_RESPONSE", 502));
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("Cloud API timeout")));
    req.on("error", () => reject(new AppError("ERR_CLOUD_API_NETWORK", 502)));
    if (data) req.write(data);
    req.end();
  });
};

const unsupported = async (): Promise<never> => {
  throw new AppError("ERR_CLOUD_API_FEATURE_NOT_SUPPORTED", 400);
};

export const CloudApiProvider: WhatsappProvider = {
  async init(whatsapp) {
    const config = checkSession(whatsapp.id);
    if (!process.env.WHATSAPP_CLOUD_APP_SECRET || !process.env.WHATSAPP_CLOUD_VERIFY_TOKEN) {
      throw new AppError("ERR_CLOUD_API_WEBHOOK_CONFIGURATION", 503);
    }
    await cloudRequest(`${config.phoneId}?fields=id,display_phone_number`);
    await whatsapp.update({ status: "CONNECTED", qrcode: "", retries: 0 });
    getIO().emit("whatsappSession", { action: "update", session: whatsapp });
  },
  removeSession() {
    // Cloud API has no local browser session to destroy.
  },
  async logout(sessionId) {
    checkSession(sessionId);
    const whatsapp = await Whatsapp.findByPk(sessionId);
    if (whatsapp) {
      await whatsapp.update({ status: "DISCONNECTED" });
      getIO().emit("whatsappSession", { action: "update", session: whatsapp });
    }
  },
  async sendMessage(sessionId, to, body, options) {
    const config = checkSession(sessionId);
    const number = to.replace(/@c\.us$/, "").replace(/^\+/, "");
    if (!/^\d{7,15}$/.test(number) || !body || body.length > 4096) {
      throw new AppError("ERR_CLOUD_API_INVALID_MESSAGE", 400);
    }
    const whatsapp = await Whatsapp.findByPk(sessionId);
    if (!whatsapp || whatsapp.status !== "CONNECTED") {
      throw new AppError("ERR_WAPP_NOT_INITIALIZED", 400);
    }
    const response = await cloudRequest(`${config.phoneId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: number,
      type: "text",
      text: { body, preview_url: options?.linkPreview || false },
      ...(options?.quotedMessageId ? { context: { message_id: options.quotedMessageId } } : {})
    });
    const id = response.messages?.[0]?.id;
    if (!id) throw new AppError("ERR_CLOUD_API_RESPONSE", 502);
    const message = {
      id, body, fromMe: true, hasMedia: false, type: "chat" as const,
      timestamp: Math.floor(Date.now() / 1000), from: config.phoneId,
      to: number, ack: 1 as const
    };
    // Cloud API does not echo sent messages as WhatsApp Web does.
    await handleMessage(message, { name: number, number, isGroup: false },
      { whatsappId: sessionId, unreadMessages: 0 }, undefined, true);
    return message;
  },
  sendMedia: unsupported,
  deleteMessage: unsupported,
  async checkNumber(sessionId, number) {
    checkSession(sessionId);
    // Cloud API has no public WhatsApp-number lookup endpoint.
    return /^\d{7,15}$/.test(number) ? number : "";
  },
  async getProfilePicUrl() { return ""; },
  getContacts: unsupported,
  async sendSeen() {
    // The common interface supplies a chat ID, but Cloud API requires a message ID.
  },
  fetchChatMessages: unsupported
};
