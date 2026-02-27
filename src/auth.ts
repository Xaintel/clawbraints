import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";

import type { FastifyReply, FastifyRequest } from "fastify";

import { getSettings } from "./settings";

function readTokenFile(filePath: string): string | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`token file must have permission 600: ${filePath}`);
  }

  const token = fs.readFileSync(filePath, "utf-8").trim();
  return token || null;
}

function timingSafeStringMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function getExpectedToken(): string | null {
  const envToken = (process.env.CLAWBRAIN_API_TOKEN ?? "").trim();
  if (envToken) {
    return envToken;
  }

  const settings = getSettings();
  return readTokenFile(settings.apiTokenFile);
}

export function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  let expected: string | null;
  try {
    expected = getExpectedToken();
  } catch (error) {
    reply.code(401).send({ detail: String(error) });
    return false;
  }

  const provided = String(request.headers["x-clawbrain-token"] ?? "").trim();

  if (!expected || !provided || !timingSafeStringMatch(provided, expected)) {
    reply.code(401).send({ detail: "unauthorized" });
    return false;
  }

  return true;
}

export function requireAuthOrQueryToken(request: FastifyRequest, reply: FastifyReply): boolean {
  let expected: string | null;
  try {
    expected = getExpectedToken();
  } catch (error) {
    reply.code(401).send({ detail: String(error) });
    return false;
  }

  const query = (request.query as { token?: string } | undefined) ?? {};
  const provided = String(request.headers["x-clawbrain-token"] ?? query.token ?? "").trim();

  if (!expected || !provided || !timingSafeStringMatch(provided, expected)) {
    reply.code(401).send({ detail: "unauthorized" });
    return false;
  }

  return true;
}
