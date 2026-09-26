import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { isValidSessionToken } from "./auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  isOwner: boolean;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  const token = parse(opts.req.headers.cookie ?? "")[COOKIE_NAME];
  return { req: opts.req, res: opts.res, isOwner: isValidSessionToken(token) };
}
