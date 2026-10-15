import { createHmac, timingSafeEqual } from "crypto";

export const validCloudSignature = (
  body: Buffer, signature: string | undefined, secret: string
): boolean => {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature.slice(7), "hex");
  return timingSafeEqual(expected, actual);
};
